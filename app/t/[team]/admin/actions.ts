"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { createMember } from "@/lib/admin/members";
import { syncMemberActor } from "@/lib/graph/company-actors";
import { issueApiKey as issueApiKeyPrimitive, revokeApiKey as revokeApiKeyPrimitive } from "@/lib/admin/keys";
import { issueLoginLink } from "@/lib/admin/login";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { isPasswordStrongEnough, randomPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { sendInviteEmail, magicLinkAvailable, buildManualInviteMessage } from "@/lib/auth/mailer";

// Generous window for an admin-issued invite (vs. the 15-minute TTL for a self-service login link)
// — the invitee may not open their email right away.
const INVITE_LINK_TTL_MINUTES = 7 * 24 * 60;

/** `APP_URL` if set, else the request's own host — so there's always a URL to show, even on a
 * fresh self-host with no domain configured yet. */
async function resolveTeamUrl(): Promise<string> {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "";
}

export type InviteMemberResult =
  | { ok: true; mode: "magic-link"; email: string; emailDelivered: boolean }
  | {
      ok: true;
      mode: "manual";
      reason: "no-mail" | "admin-choice";
      email: string;
      password: string;
      inviteMessage: string;
    }
  | { ok: false; error: string };

/**
 * Create a member and get them working sign-in access, one of two ways depending on this
 * deployment:
 *  - **Magic-link** (default when `magicLinkAvailable()` — mail delivery is configured): email a
 *    one-click, single-use sign-in link, valid 7 days. No password is set.
 *  - **Manual** (mail delivery isn't configured, or the admin explicitly typed `form.password`):
 *    set a password directly and return a complete, ready-to-paste invite (team brain URL,
 *    sign-in email, password) for the admin to share out-of-band (Slack, DM, etc) — this is the
 *    expected default path for a fresh self-hosted deployment with no mail provider set up.
 */
export async function inviteMember(
  teamSlug: string,
  form: {
    email: string;
    displayName: string;
    actorHandle: string;
    role: "admin" | "lead" | "member";
    /** When true, skip the magic-link invite even if mail delivery is configured. */
    manualInvite?: boolean;
    password?: string;
  }
): Promise<InviteMemberResult> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const useMagicLink = magicLinkAvailable() && !form.manualInvite;

  let password = "";
  if (!useMagicLink) {
    password = form.password?.trim() || randomPassword();
    if (!isPasswordStrongEnough(password)) {
      return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }
  }

  const email = form.email.trim().toLowerCase();
  const db = adminClient();
  let newMemberId: string;
  try {
    const created = await createMember(
      db,
      ctx.teamId,
      {
        email: form.email,
        displayName: form.displayName,
        actorHandle: form.actorHandle,
        role: form.role,
      },
      { actor: { kind: "member", memberId: ctx.memberId } }
    );
    newMemberId = created.id;
    if (!useMagicLink) await adminSetPassword(email, password);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "create failed" };
  }

  // Best-effort — the company graph is a derived context surface, not the source of truth; a
  // transient sync hiccup must never block onboarding a real person.
  try {
    await syncMemberActor(db, ctx.teamId, newMemberId);
  } catch (e) {
    console.error("[company-graph] actor sync failed on invite:", e instanceof Error ? e.message : e);
  }

  const [{ data: team }, { data: inviter }] = await Promise.all([
    db.from("teams").select("name").eq("id", ctx.teamId).maybeSingle(),
    db.from("members").select("display_name").eq("id", ctx.memberId).maybeSingle(),
  ]);
  const teamName = (team as { name: string } | null)?.name ?? teamSlug;
  const inviterName = (inviter as { display_name: string } | null)?.display_name ?? "Your admin";

  if (useMagicLink) {
    const { url } = await issueLoginLink(db, ctx.teamId, email, {
      nextPath: `/t/${teamSlug}`,
      ttlMinutes: INVITE_LINK_TTL_MINUTES,
      baseUrl: process.env.APP_URL,
      actor: { kind: "member", memberId: ctx.memberId },
    });
    if (!url) return { ok: false, error: "could not issue a sign-in link" };

    let emailDelivered = false;
    try {
      emailDelivered = await sendInviteEmail(email, {
        inviteeName: form.displayName,
        teamName,
        inviterName,
        loginUrl: url,
      });
    } catch (e) {
      console.error("[invite] email send failed:", e instanceof Error ? e.message : e);
    }

    revalidatePath(`/t/${teamSlug}/admin/members`);
    return { ok: true, mode: "magic-link", email, emailDelivered };
  }

  const manualReason = form.manualInvite ? "admin-choice" : "no-mail";
  const inviteMessage = buildManualInviteMessage({
    inviteeName: form.displayName,
    teamName,
    inviterName,
    teamUrl: await resolveTeamUrl(),
    email,
    password,
  });

  revalidatePath(`/t/${teamSlug}/admin/members`);
  return { ok: true, mode: "manual", reason: manualReason, email, password, inviteMessage };
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
      actor: { kind: "member", memberId: ctx.memberId },
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
      actor: { kind: "member", memberId: ctx.memberId },
    });
    revalidatePath(`/t/${teamSlug}/admin/keys`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "revoke failed" };
  }
}
