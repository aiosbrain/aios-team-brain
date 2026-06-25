"use server";

import { revalidatePath } from "next/cache";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { getSessionUser } from "@/lib/auth/session";
import { resolveIntegrationsAdmin } from "@/lib/integrations/read";
import { linkGithub } from "@/lib/codebases/github";
import { setMemberIdentity } from "@/lib/identity/member-identities";

/**
 * Admin gate for member mutations: resolve the signed-in user to an `{teamId, memberId}` admin
 * context (same role==="admin" + active-member check the /admin layout uses; `resolveIntegrationsAdmin`
 * is the shared team-admin resolver). Returns null for any non-admin/unknown/wrong-team caller.
 */
async function requireAdmin(teamSlug: string) {
  const supabase = await serverClient();
  const user = await getSessionUser();
  if (!user) return null;
  return resolveIntegrationsAdmin(supabase, teamSlug, user.id);
}

/**
 * Link a roster member to a GitHub login (admins only). Reuses `linkGithub`, which writes
 * `members.github_login` + `avatar_url` and backfills the member's git-author aliases (incl. the
 * privacy-preserving noreply forms) so their existing contributions attribute correctly. The
 * GitHub token comes from the server's GITHUB_TOKEN env — never the client, never logged.
 */
export async function linkMemberGithub(
  teamSlug: string,
  memberId: string,
  login: string
): Promise<{ ok: boolean; error?: string; login?: string; backfilled?: number }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const handle = login.trim().replace(/^@/, "");
  if (!handle) return { ok: false, error: "github login is required" };
  const token = process.env.GITHUB_TOKEN;
  if (!token) return { ok: false, error: "GITHUB_TOKEN is not configured on the server" };
  try {
    const res = await linkGithub(adminClient(), ctx.teamId, memberId, token, handle, {
      actor: { kind: "member", memberId: ctx.memberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/members`);
    return { ok: true, login: res.login, backfilled: res.backfilled };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not link github" };
  }
}

/**
 * Map a roster member to their Slack user id (admins only) — the manual path for when the Slack
 * connector lacks the `users:read.email` scope to auto-reconcile. Writes a `member_identities`
 * row (provider=slack), so future Slack ingestion attributes that user's threads to this member.
 * Admin-set, so it forces over any prior mapping.
 */
export async function linkMemberSlack(
  teamSlug: string,
  memberId: string,
  slackUserId: string,
  handle?: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const externalId = slackUserId.trim();
  if (!externalId) return { ok: false, error: "slack user id is required (e.g. U0123ABC)" };
  try {
    await setMemberIdentity(
      adminClient(),
      ctx.teamId,
      memberId,
      { provider: "slack", externalId, handle: (handle ?? "").trim() },
      { force: true, actor: { kind: "member", memberId: ctx.memberId } }
    );
    revalidatePath(`/t/${teamSlug}/admin/members`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not link slack" };
  }
}
