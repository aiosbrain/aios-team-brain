import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { runSql } from "@/lib/db/pg/pool";
import { advanceAuthorizationEpoch } from "@/lib/access/authorization-epoch";
import { withIdentityMutationBoundary } from "@/lib/identity/authority";

/**
 * The single writer for `member_identities` — maps a provider's stable user id (Slack `Uxxx`,
 * Linear/Plane user id, …) to a roster member. Collision-safe like the git-alias writer: a row
 * already mapped to a DIFFERENT member is left as-is and reported unless `force` is set, so an
 * automatic by-email sync can never silently clobber a deliberate manual mapping. Updates only
 * patch the non-empty fields provided (so a handle-only manual map doesn't wipe a synced email).
 */

export interface IdentityActor {
  kind?: "member" | "system" | "api_key";
  memberId?: string | null;
}

export interface SetIdentityInput {
  provider: string;
  externalId: string;
  handle?: string;
  email?: string;
}

export interface SetIdentityResult {
  created: boolean;
  updated: boolean;
  conflict: boolean;
  memberId: string;
  mappingRevision?: number;
  note?: string;
  /** `respectTombstone` only: the identity was deliberately unlinked, so nothing was written. */
  tombstoned?: boolean;
}

export async function advanceIdentityMappingState(input: {
  teamId: string;
  provider: string;
  externalId: string;
  memberId: string | null;
  state: "linked" | "unlinked";
}): Promise<number> {
  const { rows } = await runSql<{ revision: string | number }>(
    `insert into member_identity_mapping_state(team_id,provider,external_id,member_id,revision,state,updated_at)
     values ($1,$2,$3,$4,1,$5,now())
     on conflict (team_id,provider,external_id) do update set
       member_id=excluded.member_id,
       revision=member_identity_mapping_state.revision+1,
       state=excluded.state,
       updated_at=now()
     returning revision`,
    [input.teamId, input.provider, input.externalId, input.memberId, input.state],
  );
  const revision = Number(rows[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) throw new Error("identity mapping revision write failed");
  if (input.provider === "gdrive") {
    await runSql(
      `insert into identity_repair_obligations(team_id,provider,external_id,mapping_revision,status,updated_at)
       values ($1,$2,$3,$4,'pending',now())
       on conflict (team_id,provider,external_id,mapping_revision) do nothing`,
      [input.teamId, input.provider, input.externalId, revision],
    );
    // Cross-process Timeline/arc memory is fenced by the durable team epoch. Advance it in the same
    // transaction as the mapping revision so no process can keep serving the prior credit while the
    // bounded repair drains.
    await advanceAuthorizationEpoch(input.teamId);
  }
  return revision;
}

/**
 * The canonical spelling of an identity id for WRITING a link (AIO-1167 R47 F8). Only the email
 * namespace has one: `author-email:<address>` is case-insensitive, so its address is trimmed and
 * lowercased — the spelling the OAuth publisher and the sidecar already produce. Opaque provider ids
 * (`subject:`, `permission:`, and every non-Drive provider's ids) are case-sensitive and keep their
 * exact bytes. Unlink deliberately does NOT canonicalize: it removes an existing row by its stored
 * spelling, so a legacy differently-spelled row can still be removed explicitly.
 */
export function canonicalIdentityId(provider: string, externalId: string): string {
  const id = externalId.trim();
  const match = /^author-email:(.*)$/i.exec(id);
  if (provider.trim().toLowerCase() !== "gdrive" || !match) return id;
  return `author-email:${match[1].trim().toLowerCase()}`;
}

export async function setMemberIdentity(
  admin: DbClient,
  teamId: string,
  memberId: string,
  input: SetIdentityInput,
  opts: {
    force?: boolean;
    expectedRevision?: number;
    actor?: IdentityActor;
    /**
     * AUTOMATIC publication (AIO-1167 R47 F1): a deliberate unlink tombstone stands. An identity
     * whose mapping state is `unlinked` is left exactly as it is — no row, no state, no repair, no
     * epoch — and reported `tombstoned`. Explicit Admin links never pass this, so a revision-fenced
     * manual relink of a tombstone stays available.
     */
    respectTombstone?: boolean;
  } = {}
): Promise<SetIdentityResult> {
  const provider = input.provider.trim().toLowerCase();
  const externalId = canonicalIdentityId(provider, input.externalId);
  if (!provider || !externalId) throw new Error("provider and externalId are required");
  if (provider === "gdrive" && !/^(subject|permission|author-email):[^\s:][^\s]*$/i.test(externalId)) {
    throw new Error("Google Drive identity must use a verified subject:, permission:, or author-email: key");
  }
  const handle = (input.handle ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  return withIdentityMutationBoundary(teamId, async () => {
    const res: SetIdentityResult = { created: false, updated: false, conflict: false, memberId };
    // Team lock first, then exact identity lock: snapshots/repairs use the same order, preventing
    // deadlocks while the DB trigger advances the team-wide revision for the row mutation below.
    await runSql(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${teamId}:identity:${provider}:${externalId}`,
    ]);
    const { rows: members } = await runSql<{ id: string; status: string; is_connector: boolean }>(
      `select id,status,is_connector from members where team_id=$1 and id=$2 for share`,
      [teamId, memberId],
    );
    const target = members[0];
    if (!target) throw new Error("identity target is not a member of this team");
    if (target.status === "disabled") throw new Error("identity target is deactivated");
    if (provider === "gdrive" && target.is_connector) {
      throw new Error("Google Drive identities cannot be credited to connector service accounts");
    }

    const { rows } = await runSql<{ id: string; member_id: string }>(
      `select id,member_id from member_identities
        where team_id=$1 and provider=$2 and external_id=$3 for update`,
      [teamId, provider, externalId],
    );
    const ex = rows[0];
    const { rows: mappingRows } = await runSql<{ revision: string | number; state: string }>(
      `select revision,state from member_identity_mapping_state
        where team_id=$1 and provider=$2 and external_id=$3 for update`,
      [teamId, provider, externalId],
    );
    const currentRevision = Number(mappingRows[0]?.revision ?? 0);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== currentRevision) {
      throw new Error("identity mapping changed concurrently; refresh and retry");
    }
    if (opts.respectTombstone && mappingRows[0]?.state === "unlinked") {
      res.tombstoned = true;
      res.mappingRevision = currentRevision;
      return res;
    }
    if (!ex && provider === "gdrive" && externalId.startsWith("author-email:")) {
      // The same address in another spelling is the same person-key: never merged or overwritten
      // here — the Admin unlinks the differently spelled row explicitly, then links (R47 F8).
      const { rows: spelled } = await runSql<{ external_id: string }>(
        `select external_id from member_identities
          where team_id=$1 and provider=$2 and lower(external_id)=$3 and external_id<>$3 limit 1`,
        [teamId, provider, externalId],
      );
      if (spelled[0]) {
        throw new Error(
          `a differently spelled Google identity (${spelled[0].external_id}) already exists; unlink it first, then link ${externalId}`,
        );
      }
    }
    let mappingChanged = false;
    if (!ex) {
      await runSql(
        `insert into member_identities(team_id,member_id,provider,external_id,handle,email)
         values ($1,$2,$3,$4,$5,$6)`,
        [teamId, memberId, provider, externalId, handle, email],
      );
      res.created = true;
      mappingChanged = true;
    } else if (ex.member_id === memberId) {
      await runSql(
        `update member_identities set
           handle=case when $2<>'' then $2 else handle end,
           email=case when $3<>'' then $3::citext else email end
         where id=$1`,
        [ex.id, handle, email],
      );
      res.updated = true;
    } else if (opts.force) {
      await runSql(
        `update member_identities set member_id=$2,
           handle=case when $3<>'' then $3 else handle end,
           email=case when $4<>'' then $4::citext else email end
         where id=$1`,
        [ex.id, memberId, handle, email],
      );
      res.updated = true;
      mappingChanged = true;
    } else {
      res.conflict = true;
      res.note = `${provider} identity ${externalId} already maps to a different member; pass force to remap`;
      return res;
    }

    if (mappingChanged) {
      res.mappingRevision = await advanceIdentityMappingState({
        teamId, provider, externalId, memberId, state: "linked",
      });
    } else {
      const { rows: stateRows } = await runSql<{ revision: string | number }>(
        `select revision from member_identity_mapping_state
          where team_id=$1 and provider=$2 and external_id=$3`,
        [teamId, provider, externalId],
      );
      if (!stateRows[0]) {
        res.mappingRevision = await advanceIdentityMappingState({
          teamId, provider, externalId, memberId, state: "linked",
        });
      } else {
        res.mappingRevision = Number(stateRows[0].revision);
      }
    }

    await audit(admin, {
      team_id: teamId,
      actor_kind: opts.actor?.kind ?? "system",
      member_id: opts.actor?.memberId ?? null,
      action: "identity.set",
      target_type: "member",
      target_id: memberId,
      meta: {
        provider, external_id: externalId, created: res.created, updated: res.updated,
        mapping_revision: res.mappingRevision,
      },
    });
    return res;
  });
}

export type DiscoveredIdentityOutcome = "linked" | "exists" | "conflict" | "reviewed" | "ineligible";

/**
 * An evidence-backed AUTOMATIC link of a stable provider identity (AIO-1167 R44 F1) — far narrower
 * than `setMemberIdentity`. It creates a link only for an identity that has NEVER been reviewed: no
 * mapping row and no mapping state at all, so a deliberate unlink tombstone, an existing link, or a
 * manual mapping always wins. It never remaps and never links a deactivated member or a connector. A
 * reviewed decision (a mapping-state row: a link or an unlink tombstone) is `reviewed` whatever email
 * is observed later; only an UNREVIEWED legacy mapping held by another member is a `conflict` —
 * audited (`identity.discovery_conflict`), nothing changes. A created link goes through
 * the same mapping-state revision, repair obligation and epoch protocol as every other link.
 * The caller decides the evidence; this owner decides only whether a link may be created.
 */
export async function discoverMemberIdentity(
  admin: DbClient,
  teamId: string,
  memberId: string,
  input: { provider: string; externalId: string; email?: string | null; handle?: string | null },
  opts: { actor?: IdentityActor } = {},
): Promise<DiscoveredIdentityOutcome> {
  const provider = input.provider.trim().toLowerCase();
  const externalId = input.externalId.trim();
  if (!provider || !externalId) throw new Error("provider and externalId are required");
  if (provider === "gdrive" && !/^permission:[^\s:][^\s]*$/i.test(externalId)) {
    throw new Error("automatic Google Drive links are made only for permission: identities");
  }
  const email = (input.email ?? "").trim().toLowerCase();
  const handle = (input.handle ?? "").trim();
  return withIdentityMutationBoundary(teamId, async () => {
    await runSql(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${teamId}:identity:${provider}:${externalId}`,
    ]);
    const { rows: members } = await runSql<{ status: string; is_connector: boolean }>(
      `select status,is_connector from members where team_id=$1 and id=$2 for share`,
      [teamId, memberId],
    );
    const target = members[0];
    if (!target || target.status === "disabled" || target.is_connector) return "ineligible";
    const { rows: existing } = await runSql<{ member_id: string }>(
      `select member_id from member_identities where team_id=$1 and provider=$2 and external_id=$3 for update`,
      [teamId, provider, externalId],
    );
    if (existing[0]?.member_id === memberId) return "exists";
    // Same lock order as before (identity row, then mapping state); the DECISION waits for both.
    const { rows: states } = await runSql<{ state: string }>(
      `select state from member_identity_mapping_state
        where team_id=$1 and provider=$2 and external_id=$3 for update`,
      [teamId, provider, externalId],
    );
    // Any prior decision — a reviewed link to someone else, or an unlink tombstone — stands, and a later
    // email disagreeing with it is NOT a conflict (AIO-1167 R45, AC-08): it is not audited as one.
    if (states[0]) return "reviewed";
    if (existing[0]) {
      // Only an UNREVIEWED legacy mapping held by another member is a refused automatic link — the
      // event the Admin diagnostic (`lib/identity/discovery-conflicts`) surfaces.
      await audit(admin, {
        team_id: teamId, actor_kind: opts.actor?.kind ?? "system", member_id: opts.actor?.memberId ?? null,
        action: "identity.discovery_conflict", target_type: "member", target_id: memberId,
        meta: { provider, external_id: externalId, mapped_member_id: existing[0].member_id },
      });
      return "conflict";
    }
    await runSql(
      `insert into member_identities(team_id,member_id,provider,external_id,handle,email)
       values ($1,$2,$3,$4,$5,$6)`,
      [teamId, memberId, provider, externalId, handle, email],
    );
    const mappingRevision = await advanceIdentityMappingState({
      teamId, provider, externalId, memberId, state: "linked",
    });
    await audit(admin, {
      team_id: teamId, actor_kind: opts.actor?.kind ?? "system", member_id: opts.actor?.memberId ?? null,
      action: "identity.discovered", target_type: "member", target_id: memberId,
      meta: { provider, external_id: externalId, mapping_revision: mappingRevision },
    });
    return "linked";
  });
}

/** Remove a provider identity mapping (admins correcting/clearing a link). Audited; no-op if absent. */
export async function removeMemberIdentity(
  admin: DbClient,
  teamId: string,
  input: { provider: string; externalId: string },
  opts: { expectedRevision?: number; actor?: IdentityActor } = {}
): Promise<{ removed: boolean; mappingRevision?: number }> {
  const provider = input.provider.trim().toLowerCase();
  const externalId = input.externalId.trim();
  if (!provider || !externalId) throw new Error("provider and externalId are required");
  if (provider === "gdrive" && !/^(subject|permission|author-email):[^\s:][^\s]*$/i.test(externalId)) {
    throw new Error("Google Drive identity must use a verified subject:, permission:, or author-email: key");
  }

  return withIdentityMutationBoundary(teamId, async () => {
    await runSql(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${teamId}:identity:${provider}:${externalId}`,
    ]);
    const { rows } = await runSql<{ id: string; member_id: string }>(
      `select id,member_id from member_identities
        where team_id=$1 and provider=$2 and external_id=$3 for update`,
      [teamId, provider, externalId],
    );
    const ex = rows[0];
    const { rows: mappingRows } = await runSql<{ revision: string | number }>(
      `select revision from member_identity_mapping_state
        where team_id=$1 and provider=$2 and external_id=$3 for update`,
      [teamId, provider, externalId],
    );
    const currentRevision = Number(mappingRows[0]?.revision ?? 0);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== currentRevision) {
      throw new Error("identity mapping changed concurrently; refresh and retry");
    }
    if (!ex) return { removed: false };
    await runSql(`delete from member_identities where id=$1`, [ex.id]);
    const mappingRevision = await advanceIdentityMappingState({
      teamId, provider, externalId, memberId: null, state: "unlinked",
    });
    await audit(admin, {
      team_id: teamId,
      actor_kind: opts.actor?.kind ?? "system",
      member_id: opts.actor?.memberId ?? null,
      action: "identity.removed",
      target_type: "member",
      target_id: ex.member_id,
      meta: { provider, external_id: externalId, mapping_revision: mappingRevision },
    });
    return { removed: true, mappingRevision };
  });
}
