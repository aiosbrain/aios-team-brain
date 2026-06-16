"use server";

import { createHash, randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";

/** Verify the caller is an active admin of the team; returns ids or null. */
async function requireAdmin(teamSlug: string) {
  const supabase = await serverClient();
  const user = await getSessionUser();
  if (!user) return null;
  const { data: team } = await supabase
    .from("teams")
    .select("id")
    .eq("slug", teamSlug)
    .maybeSingle();
  if (!team) return null;
  const { data: me } = await supabase
    .from("members")
    .select("id, role")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (me?.role !== "admin") return null;
  return { teamId: team.id, myMemberId: me.id };
}

export async function inviteMember(
  teamSlug: string,
  form: { email: string; displayName: string; actorHandle: string; role: "admin" | "lead" | "member" }
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  // RLS-governed insert (members_admin_insert policy enforces this server-side too)
  const supabase = await serverClient();
  const { error } = await supabase.from("members").insert({
    team_id: ctx.teamId,
    email: form.email.trim().toLowerCase(),
    display_name: form.displayName.trim(),
    actor_handle: form.actorHandle.trim().toLowerCase(),
    role: form.role,
    status: "invited",
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/t/${teamSlug}/admin/members`);
  return { ok: true };
}

export async function issueApiKey(
  teamSlug: string,
  memberId: string,
  name: string
): Promise<{ ok: boolean; key?: string; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  // The secret is generated server-side and only its sha256 is stored —
  // key_hash is column-revoked from authenticated clients, so this uses the
  // admin client (the one sanctioned write path for hashes).
  const keyId = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const admin = adminClient();
  const { error } = await admin.from("api_keys").insert({
    team_id: ctx.teamId,
    member_id: memberId,
    key_id: keyId,
    key_hash: createHash("sha256").update(secret).digest("hex"),
    name: name.trim() || "unnamed key",
  });
  if (error) return { ok: false, error: error.message };

  await admin.from("audit_log").insert({
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.myMemberId,
    action: "api_key.issued",
    target_type: "api_key",
    target_id: keyId,
    meta: { for_member: memberId },
  });

  revalidatePath(`/t/${teamSlug}/admin/keys`);
  return { ok: true, key: `aios_${keyId}_${secret}` };
}

export async function revokeApiKey(
  teamSlug: string,
  apiKeyId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const supabase = await serverClient(); // RLS: api_keys_admin_update
  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", apiKeyId);
  if (error) return { ok: false, error: error.message };

  const admin = adminClient();
  await admin.from("audit_log").insert({
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.myMemberId,
    action: "api_key.revoked",
    target_type: "api_key",
    target_id: apiKeyId,
  });
  revalidatePath(`/t/${teamSlug}/admin/keys`);
  return { ok: true };
}
