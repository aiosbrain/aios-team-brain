import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/api/audit";

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
  admin: SupabaseClient,
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

  const { data: existing } = await admin
    .from("member_identities")
    .select("id, member_id")
    .eq("team_id", teamId)
    .eq("provider", provider)
    .eq("external_id", externalId)
    .maybeSingle();
  const ex = existing as { id: string; member_id: string } | null;

  if (!ex) {
    const { error } = await admin
      .from("member_identities")
      .insert({ team_id: teamId, member_id: memberId, provider, external_id: externalId, handle, email });
    if (error) throw new Error(`identity insert failed: ${error.message}`);
    res.created = true;
  } else if (ex.member_id === memberId) {
    if (Object.keys(patch).length) {
      const { error } = await admin.from("member_identities").update(patch).eq("id", ex.id);
      if (error) throw new Error(`identity update failed: ${error.message}`);
    }
    res.updated = true;
  } else if (opts.force) {
    const { error } = await admin
      .from("member_identities")
      .update({ member_id: memberId, ...patch })
      .eq("id", ex.id);
    if (error) throw new Error(`identity remap failed: ${error.message}`);
    res.updated = true;
  } else {
    res.conflict = true;
    res.note = `${provider} identity ${externalId} already maps to a different member; pass force to remap`;
    return res;
  }

  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "identity.set",
    target_type: "member",
    target_id: memberId,
    meta: { provider, external_id: externalId, created: res.created, updated: res.updated },
  });
  return res;
}

/** Remove a provider identity mapping (admins correcting/clearing a link). Audited; no-op if absent. */
export async function removeMemberIdentity(
  admin: SupabaseClient,
  teamId: string,
  input: { provider: string; externalId: string },
  opts: { actor?: IdentityActor } = {}
): Promise<{ removed: boolean }> {
  const provider = input.provider.trim().toLowerCase();
  const externalId = input.externalId.trim();
  if (!provider || !externalId) throw new Error("provider and externalId are required");

  const { data: existing } = await admin
    .from("member_identities")
    .select("id, member_id")
    .eq("team_id", teamId)
    .eq("provider", provider)
    .eq("external_id", externalId)
    .maybeSingle();
  const ex = existing as { id: string; member_id: string } | null;
  if (!ex) return { removed: false };

  const { error } = await admin.from("member_identities").delete().eq("id", ex.id);
  if (error) throw new Error(`identity delete failed: ${error.message}`);
  await audit(admin, {
    team_id: teamId,
    actor_kind: opts.actor?.kind ?? "system",
    member_id: opts.actor?.memberId ?? null,
    action: "identity.removed",
    target_type: "member",
    target_id: ex.member_id,
    meta: { provider, external_id: externalId },
  });
  return { removed: true };
}
