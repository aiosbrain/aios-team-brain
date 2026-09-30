import "server-only";
import type { DbClient, TransactionSession } from "@/lib/db/types";
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

/** Raw IDs remain live until the attended cutover. This parser only prevents a second live
 * row for the same observed Slack user; it does not qualify or migrate an existing row. */
function slackAccountParts(externalId: string): { rawId: string; qualified: boolean } | null {
  if (/^[A-Za-z0-9]+$/.test(externalId)) return { rawId: externalId, qualified: false };
  const match = /^[A-Za-z0-9]+:([A-Za-z0-9]+)$/.exec(externalId);
  return match ? { rawId: match[1], qualified: true } : null;
}

type SlackIdentityRow = { id: string; member_id: string; external_id: string };

// The resolver and credit reader fold provider IDs. All Slack writer lookups must make the
// same comparison while holding the team lock, including rows saved with older casing.
async function matchingSlackIdentities(
  session: TransactionSession, teamId: string, externalId: string
): Promise<SlackIdentityRow[]> {
  const { rows } = await session.executeSql<SlackIdentityRow>(
    `select id, member_id, external_id from member_identities
       where team_id = $1 and provider = 'slack' and lower(external_id) = lower($2)`,
    [teamId, externalId]
  );
  return rows;
}

async function matchingSlackSuppressions(
  session: TransactionSession, teamId: string, externalId: string
): Promise<string[]> {
  const { rows } = await session.executeSql<{ external_id: string }>(
    `select external_id from member_identity_suppressions
       where team_id = $1 and provider = 'slack' and lower(external_id) = lower($2)`,
    [teamId, externalId]
  );
  return rows.map((row) => row.external_id);
}

async function liveSlackCounterpart(
  session: TransactionSession, teamId: string, externalId: string
): Promise<string | null> {
  const account = slackAccountParts(externalId);
  if (!account) return null;
  const { rows } = await session.executeSql<{ external_id: string }>(
    account.qualified
      ? `select external_id from member_identities
           where team_id = $1 and provider = 'slack' and lower(external_id) = lower($2) limit 1`
      : `select external_id from member_identities
           where team_id = $1 and provider = 'slack'
             and lower(split_part(external_id, ':', 2)) = lower($2)
             and external_id ~ '^[A-Za-z0-9]+:[A-Za-z0-9]+$' limit 1`,
    [teamId, account.rawId]
  );
  return rows[0]?.external_id ?? null;
}

export async function setMemberIdentity(
  admin: DbClient,
  teamId: string,
  memberId: string,
  input: SetIdentityInput,
  opts: { force?: boolean; explicit?: boolean; actor?: IdentityActor } = {}
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
    const { data: member, error: memberError } = await session.db.from("members")
      .select("id").eq("team_id", teamId).eq("id", memberId).maybeSingle();
    if (memberError) throw new Error(`identity member read failed: ${memberError.message}`);
    if (!member) throw new Error("identity member does not belong to team");
    let ex: SlackIdentityRow | { id: string; member_id: string } | null;
    if (provider === "slack") {
      const matches = await matchingSlackIdentities(session, teamId, externalId);
      if (matches.length > 1) {
        res.conflict = true;
        res.note = `Slack account ${externalId} has multiple live case variants; resolve them before linking`;
        return res;
      }
      ex = matches[0] ?? null;
    } else {
      const { data, error } = await session.db.from("member_identities")
        .select("id, member_id").eq("team_id", teamId).eq("provider", provider)
        .eq("external_id", externalId).maybeSingle();
      if (error) throw new Error(`identity read failed: ${error.message}`);
      ex = data as { id: string; member_id: string } | null;
    }

    // Only Slack has unlink suppression in this packet. An automatic writer must read it
    // inside the same team lock as the mapping, and a failed read must abort the sync.
    let suppressionKeys: string[] = [];
    let suppressed = false;
    if (provider === "slack") {
      suppressionKeys = await matchingSlackSuppressions(session, teamId, externalId);
      suppressed = suppressionKeys.length > 0;
      const account = slackAccountParts(externalId);
      if (account && !ex) {
        if (await liveSlackCounterpart(session, teamId, externalId)) {
          res.conflict = true;
          res.note = `Slack account ${externalId} has a live raw/qualified counterpart; use the attended identity cutover`;
          return res;
        }
      }
      // A legacy-key fence blocks creation through the other key shape. Once an
      // authorized qualified link exists, its own automatic metadata refresh is safe.
      if (!opts.explicit && !suppressed && account && !ex) {
        const { rows } = await session.executeSql<{ external_id: string }>(
          account.qualified
            ? `select external_id from member_identity_suppressions
                 where team_id = $1 and provider = 'slack' and lower(external_id) = lower($2) limit 1`
            : `select external_id from member_identity_suppressions
                 where team_id = $1 and provider = 'slack'
                   and lower(split_part(external_id, ':', 2)) = lower($2)
                   and external_id ~ '^[A-Za-z0-9]+:[A-Za-z0-9]+$' limit 1`,
          [teamId, account.rawId]
        );
        suppressed = rows.length > 0;
      }
      if (suppressed && !opts.explicit) {
        res.conflict = true;
        res.note = `Slack account ${externalId} was explicitly unlinked; authorized relink is required`;
        return res;
      }
    }

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

    if (provider === "slack" && suppressed) {
      for (const key of suppressionKeys) {
        const { error } = await session.db.from("member_identity_suppressions").delete()
          .eq("team_id", teamId).eq("provider", provider).eq("external_id", key);
        if (error) throw new Error(`identity suppression clear failed: ${error.message}`);
      }
    }

    if (provider === "slack" && (suppressed || res.created || (ex && ex.member_id !== memberId))) {
      await bumpSlackIdentityGeneration(session, teamId);
    }
    await audit(session.db, {
      team_id: teamId,
      actor_kind: opts.actor?.kind ?? "system",
      member_id: opts.actor?.memberId ?? null,
      action: "identity.set",
      target_type: "member",
      target_id: memberId,
      meta: { provider, external_id: externalId, created: res.created, updated: res.updated,
        suppression_cleared: suppressed },
    });
    return res;
  });
}

/** Unlink an identity. Slack records an absent-key fence; repeating it is a no-op. */
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
    let ex: SlackIdentityRow | { id: string; member_id: string } | null;
    if (provider === "slack") {
      const matches = await matchingSlackIdentities(session, teamId, externalId);
      if (matches.length > 1) throw new Error(`Slack account ${externalId} has multiple live case variants`);
      ex = matches[0] ?? null;
    } else {
      const { data, error } = await session.db.from("member_identities")
        .select("id, member_id").eq("team_id", teamId).eq("provider", provider)
        .eq("external_id", externalId).maybeSingle();
      if (error) throw new Error(`identity read failed: ${error.message}`);
      ex = data as { id: string; member_id: string } | null;
    }
    let suppressed = false;
    if (provider === "slack") {
      suppressed = (await matchingSlackSuppressions(session, teamId, externalId)).length > 0;
      if (!ex) {
        const counterpart = await liveSlackCounterpart(session, teamId, externalId);
        if (counterpart) {
          throw new Error(`Slack account ${externalId} is live as ${counterpart}; unlink that exact key`);
        }
      }
    }
    if (!ex && (provider !== "slack" || suppressed)) return { removed: false };

    if (ex) {
      const { error } = await session.db.from("member_identities").delete().eq("id", ex.id);
      if (error) throw new Error(`identity delete failed: ${error.message}`);
    }
    if (provider === "slack") {
      if (!suppressed) {
        const { error } = await session.db.from("member_identity_suppressions")
          .insert({ team_id: teamId, provider,
            external_id: ex && "external_id" in ex ? ex.external_id : externalId });
        if (error) throw new Error(`identity suppression insert failed: ${error.message}`);
      }
      if (ex || !suppressed) await bumpSlackIdentityGeneration(session, teamId);
    }
    await audit(session.db, {
      team_id: teamId,
      actor_kind: opts.actor?.kind ?? "system",
      member_id: opts.actor?.memberId ?? null,
      action: ex ? "identity.removed" : "identity.suppressed",
      target_type: ex ? "member" : "identity",
      target_id: ex?.member_id ?? null,
      meta: { provider, external_id: externalId, suppressed: provider === "slack" },
    });
    return { removed: Boolean(ex) };
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
