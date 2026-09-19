import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { transactionCapability } from "@/lib/projects/context/transaction";
import { bumpSlackIdentityGeneration } from "@/lib/ingest/slack-message-ledger";

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
  note?: string;
}

export async function setMemberIdentity(
  admin: DbClient,
  teamId: string,
  memberId: string,
  input: SetIdentityInput,
  opts: { force?: boolean; actor?: IdentityActor } = {}
): Promise<SetIdentityResult> {
  const provider = input.provider.trim().toLowerCase();
  const externalId = input.externalId.trim();
  if (!provider || !externalId) throw new Error("provider and externalId are required");
  const handle = (input.handle ?? "").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  const res: SetIdentityResult = { created: false, updated: false, conflict: false, memberId };

  const patch: Record<string, unknown> = {};
  if (handle) patch.handle = handle;
  if (email) patch.email = email;

  return transactionCapability(admin).transaction(async (session) => {
    // One team lock also coordinates hard member deletion, whose FK cascade removes identity rows.
    // It covers absent keys so competing sync/admin writes compare their real predecessor.
    await session.executeSql("select pg_advisory_xact_lock(7341014, hashtext($1))", [teamId]);
    const { data: existing, error: readError } = await session.db.from("member_identities")
      .select("id, member_id").eq("team_id", teamId).eq("provider", provider)
      .eq("external_id", externalId).maybeSingle();
    if (readError) throw new Error(`identity read failed: ${readError.message}`);
    const ex = existing as { id: string; member_id: string } | null;

    if (!ex) {
      const { error } = await session.db.from("member_identities")
        .insert({ team_id: teamId, member_id: memberId, provider, external_id: externalId, handle, email });
      if (error) throw new Error(`identity insert failed: ${error.message}`);
      res.created = true;
    } else if (ex.member_id === memberId) {
      if (Object.keys(patch).length) {
        const { error } = await session.db.from("member_identities").update(patch).eq("id", ex.id);
        if (error) throw new Error(`identity update failed: ${error.message}`);
      }
      res.updated = true;
    } else if (opts.force) {
      const { error } = await session.db.from("member_identities")
        .update({ member_id: memberId, ...patch }).eq("id", ex.id);
      if (error) throw new Error(`identity remap failed: ${error.message}`);
      res.updated = true;
    } else {
      res.conflict = true;
      res.note = `${provider} identity ${externalId} already maps to a different member; pass force to remap`;
      return res;
    }

    if (provider === "slack" && (res.created || (ex && ex.member_id !== memberId))) {
      await bumpSlackIdentityGeneration(session, teamId);
    }
    await audit(session.db, {
      team_id: teamId,
      actor_kind: opts.actor?.kind ?? "system",
      member_id: opts.actor?.memberId ?? null,
      action: "identity.set",
      target_type: "member",
      target_id: memberId,
      meta: { provider, external_id: externalId, created: res.created, updated: res.updated },
    });
    return res;
  });
}

/** Remove a provider identity mapping (admins correcting/clearing a link). Audited; no-op if absent. */
export async function removeMemberIdentity(
  admin: DbClient,
  teamId: string,
  input: { provider: string; externalId: string },
  opts: { actor?: IdentityActor } = {}
): Promise<{ removed: boolean }> {
  const provider = input.provider.trim().toLowerCase();
  const externalId = input.externalId.trim();
  if (!provider || !externalId) throw new Error("provider and externalId are required");

  return transactionCapability(admin).transaction(async (session) => {
    await session.executeSql("select pg_advisory_xact_lock(7341014, hashtext($1))", [teamId]);
    const { data: existing, error: readError } = await session.db.from("member_identities")
      .select("id, member_id").eq("team_id", teamId).eq("provider", provider)
      .eq("external_id", externalId).maybeSingle();
    if (readError) throw new Error(`identity read failed: ${readError.message}`);
    const ex = existing as { id: string; member_id: string } | null;
    if (!ex) return { removed: false };

    const { error } = await session.db.from("member_identities").delete().eq("id", ex.id);
    if (error) throw new Error(`identity delete failed: ${error.message}`);
    if (provider === "slack") await bumpSlackIdentityGeneration(session, teamId);
    await audit(session.db, {
      team_id: teamId,
      actor_kind: opts.actor?.kind ?? "system",
      member_id: opts.actor?.memberId ?? null,
      action: "identity.removed",
      target_type: "member",
      target_id: ex.member_id,
      meta: { provider, external_id: externalId },
    });
    return { removed: true };
  });
}

/**
 * Member hard deletion cascades through `member_identities`. Lock the member before checking its
 * Slack links so a concurrent FK-backed link cannot appear between the check and the delete.
 * The cascade and any required identity bump commit together; callers retain their own audit.
 */
export async function deleteMemberWithIdentityRevision(
  admin: DbClient, teamId: string, memberId: string
): Promise<void> {
  await transactionCapability(admin).transaction(async (session) => {
    await session.executeSql("select pg_advisory_xact_lock(7341014, hashtext($1))", [teamId]);
    const { rows: members } = await session.executeSql<{ id: string }>(
      `select id from members where team_id = $1 and id = $2 for update`, [teamId, memberId]
    );
    if (!members.length) return;
    const { rows: links } = await session.executeSql<{ id: string }>(
      `select id from member_identities
        where team_id = $1 and member_id = $2 and provider = 'slack' limit 1`,
      [teamId, memberId]
    );
    const { error } = await session.db.from("members").delete()
      .eq("team_id", teamId).eq("id", memberId);
    if (error) throw new Error(`delete member failed: ${error.message}`);
    if (links.length) await bumpSlackIdentityGeneration(session, teamId);
  });
}

/** A disabled member leaves the active timeline roster. Fence other workers' cached Slack credit
 * in the same transaction as the status transition; repeated disables are true no-ops. */
export async function disableMemberWithIdentityRevision(
  admin: DbClient, teamId: string, memberId: string
): Promise<void> {
  await transactionCapability(admin).transaction(async (session) => {
    const { rows: members } = await session.executeSql<{ status: string }>(
      `select status from members where team_id = $1 and id = $2 for update`, [teamId, memberId]
    );
    if (!members.length) return;
    const { rows: links } = await session.executeSql<{ id: string }>(
      `select id from member_identities
        where team_id = $1 and member_id = $2 and provider = 'slack' limit 1`,
      [teamId, memberId]
    );
    const { error } = await session.db.from("members")
      .update({ status: "disabled", auth_user_id: null }).eq("team_id", teamId).eq("id", memberId);
    if (error) throw new Error(`disable member failed: ${error.message}`);
    if (members[0].status === "active" && links.length) {
      await bumpSlackIdentityGeneration(session, teamId);
    }
  });
}
