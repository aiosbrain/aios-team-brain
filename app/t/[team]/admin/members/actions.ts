"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { linkGithub } from "@/lib/codebases/github";
import { setMemberIdentity, removeMemberIdentity } from "@/lib/identity/member-identities";
import { addAuthorAlias, removeAuthorAlias } from "@/lib/admin/aliases";
import { reattributeItems } from "@/lib/ingest/reattribute";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { isPasswordStrongEnough, randomPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { audit } from "@/lib/api/audit";

// Providers whose identity is a stable user id in member_identities (GitHub uses its own login flow).
const PROVIDERS = new Set(["slack", "linear", "plane"]);

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
 * Map a roster member to a provider user id (admins only) — the manual path / correction when
 * auto-reconciliation missed or mismapped (e.g. a person uses a different email on that platform).
 * Writes a `member_identities` row so future ingestion attributes that provider's content to this
 * member. Admin-set → forces over any prior mapping. Provider ∈ {slack, linear, plane} (GitHub has
 * its own login flow via `linkMemberGithub`).
 */
export async function linkMemberIdentity(
  teamSlug: string,
  memberId: string,
  provider: string,
  externalId: string,
  handle?: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const p = provider.trim().toLowerCase();
  if (!PROVIDERS.has(p)) return { ok: false, error: `unsupported provider "${provider}"` };
  const ext = externalId.trim();
  if (!ext) return { ok: false, error: `${p} user id is required` };
  try {
    await setMemberIdentity(
      adminClient(),
      ctx.teamId,
      memberId,
      { provider: p, externalId: ext, handle: (handle ?? "").trim() },
      { force: true, actor: { kind: "member", memberId: ctx.memberId } }
    );
    revalidatePath(`/t/${teamSlug}/admin/members`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not link identity" };
  }
}

/** Back-compat wrapper for the Slack-specific call site. */
export async function linkMemberSlack(
  teamSlug: string,
  memberId: string,
  slackUserId: string,
  handle?: string
): Promise<{ ok: boolean; error?: string }> {
  return linkMemberIdentity(teamSlug, memberId, "slack", slackUserId, handle);
}

/** Remove a provider identity mapping (admins clearing/correcting a link). */
export async function unlinkMemberIdentity(
  teamSlug: string,
  provider: string,
  externalId: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await removeMemberIdentity(
      adminClient(),
      ctx.teamId,
      { provider: provider.trim().toLowerCase(), externalId: externalId.trim() },
      { actor: { kind: "member", memberId: ctx.memberId } }
    );
    revalidatePath(`/t/${teamSlug}/admin/members`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not unlink identity" };
  }
}

/**
 * Add an email alias to a member (admins only) — the fix for "different email on a platform": once
 * the alternate email is an alias, every connector keying on it reconciles to this person. Reuses
 * `addAuthorAlias`, which also back-fills existing git contributions. `force` re-points an alias
 * currently on another member.
 */
export async function addMemberEmail(
  teamSlug: string,
  memberId: string,
  email: string,
  force?: boolean
): Promise<{ ok: boolean; error?: string; note?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  const e = email.trim();
  if (!e || !e.includes("@")) return { ok: false, error: "a valid email is required" };
  try {
    const res = await addAuthorAlias(adminClient(), ctx.teamId, memberId, e, {
      force,
      actor: { kind: "member", memberId: ctx.memberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/members`);
    if (res.collisions && !force) return { ok: false, error: res.note };
    return { ok: true, note: res.note };
  } catch (e2) {
    return { ok: false, error: e2 instanceof Error ? e2.message : "could not add email" };
  }
}

/**
 * Re-attribute existing content to the CURRENT identity mappings (admins only). Run this after
 * linking/correcting identities so already-ingested items (which were attributed at ingest time)
 * pick up the new mapping. Conservative — never un-attributes. See `lib/ingest/reattribute`.
 */
export async function reattributeIdentitiesNow(
  teamSlug: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    const s = await reattributeItems(adminClient(), ctx.teamId);
    revalidatePath(`/t/${teamSlug}/admin/members`);
    return { ok: true, message: `Re-attributed ${s.updated} of ${s.scanned} item(s) to current identity mappings.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "re-attribution failed" };
  }
}

/**
 * Reset a member's sign-in password (admins only) — audit M1/M2b. Sets a NEW password directly (no
 * current-password check, unlike self-service change), scoped to a member of THIS team so an admin
 * can't reach across teams via a raw memberId. Returns the plaintext password ONCE (shown-once UI,
 * same pattern as API key issuance) for the admin to hand to the person out-of-band — never emailed,
 * never logged.
 */
export async function resetMemberPassword(
  teamSlug: string,
  memberId: string,
  password?: string
): Promise<{ ok: boolean; password?: string; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const newPassword = password?.trim() || randomPassword();
  if (!isPasswordStrongEnough(newPassword)) {
    return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const db = adminClient();
  const { data: member } = await db
    .from("members")
    .select("id, email")
    .eq("id", memberId)
    .eq("team_id", ctx.teamId)
    .maybeSingle();
  if (!member) return { ok: false, error: "member not found on this team" };

  await adminSetPassword((member as { email: string }).email, newPassword);
  await audit(db, {
    team_id: ctx.teamId,
    actor_kind: "member",
    member_id: ctx.memberId,
    action: "member.password_reset",
    target_type: "member",
    target_id: memberId,
    meta: {},
  });
  revalidatePath(`/t/${teamSlug}/admin/members`);
  return { ok: true, password: newPassword };
}

/** Remove an email alias from a member (admins only). */
export async function removeMemberEmail(
  teamSlug: string,
  email: string
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };
  try {
    await removeAuthorAlias(adminClient(), ctx.teamId, email, {
      actor: { kind: "member", memberId: ctx.memberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/members`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "could not remove email" };
  }
}
