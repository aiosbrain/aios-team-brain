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

export async function setMemberIdentity(
  admin: DbClient,
  teamId: string,
  memberId: string,
  input: SetIdentityInput,
  opts: { force?: boolean; expectedRevision?: number; actor?: IdentityActor } = {}
): Promise<SetIdentityResult> {
  const provider = input.provider.trim().toLowerCase();
  const externalId = input.externalId.trim();
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
    const { rows: mappingRows } = await runSql<{ revision: string | number }>(
      `select revision from member_identity_mapping_state
        where team_id=$1 and provider=$2 and external_id=$3 for update`,
      [teamId, provider, externalId],
    );
    const currentRevision = Number(mappingRows[0]?.revision ?? 0);
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== currentRevision) {
      throw new Error("identity mapping changed concurrently; refresh and retry");
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
