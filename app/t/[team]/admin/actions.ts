"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import { createMember } from "@/lib/admin/members";
import { issueApiKey as issueApiKeyPrimitive, revokeApiKey as revokeApiKeyPrimitive } from "@/lib/admin/keys";

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

  try {
    await createMember(
      adminClient(),
      ctx.teamId,
      {
        email: form.email,
        displayName: form.displayName,
        actorHandle: form.actorHandle,
        role: form.role,
      },
      { actor: { kind: "member", memberId: ctx.myMemberId } }
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "create failed" };
  }
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

  try {
    const { key } = await issueApiKeyPrimitive(adminClient(), ctx.teamId, memberId, name, {
      actor: { kind: "member", memberId: ctx.myMemberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/keys`);
    return { ok: true, key };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "issue failed" };
  }
}

export async function revokeApiKey(
  teamSlug: string,
  apiKeyId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  try {
    await revokeApiKeyPrimitive(adminClient(), ctx.teamId, apiKeyId, {
      actor: { kind: "member", memberId: ctx.myMemberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/keys`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "revoke failed" };
  }
}
