"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { createMember, rollbackMemberCreation, MemberExistsError, isValidInviteEmail } from "@/lib/admin/members";
import { syncMemberActor } from "@/lib/graph/company-actors";
import { issueApiKey as issueApiKeyPrimitive, revokeApiKey as revokeApiKeyPrimitive } from "@/lib/admin/keys";
import { isPasswordStrongEnough, randomPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { magicLinkAvailable } from "@/lib/auth/mailer";
import { issueMemberInvite } from "@/lib/admin/invite";
import { getProvisioningAvailability } from "@/lib/provisioning/run";
import type { ProvisioningResult, ProvisioningTool } from "@/lib/provisioning/types";

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
  | {
      ok: true;
      mode: "magic-link";
      email: string;
      emailDelivered: boolean;
      /** Set ONLY when `emailDelivered` is false — the already-issued sign-in link, so the admin
       * has a working fallback instead of a dead end. Security-equivalent to the manual path's
       * password reveal: same admin, same screen, shown once. */
      loginUrl?: string;
      /** Per-tool provisioning cascade outcomes (empty when tools = "none"). Best-effort — never
       * affects whether the invite itself succeeded. */
      provisioning: ProvisioningResult[];
    }
  | {
      ok: true;
      mode: "manual";
      reason: "no-mail" | "admin-choice";
      email: string;
      password: string;
      inviteMessage: string;
      provisioning: ProvisioningResult[];
    }
  | { ok: false; error: string };

/**
 * Create a member and get them working sign-in access, one of two ways depending on this
 * deployment:
 *  - **Magic-link** (default when `magicLinkAvailable()` — mail delivery is configured): email a
 *    one-click, single-use sign-in link, valid 14 days. No password is set.
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
    /** Which external tools to provision the new member into. Default "all". */
    tools?: ProvisioningTool[] | "all" | "none";
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
  if (!isValidInviteEmail(email)) {
    return { ok: false, error: "invalid email address" };
  }

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
  } catch (e) {
    if (e instanceof MemberExistsError) return { ok: false, error: e.message };
    return { ok: false, error: e instanceof Error ? e.message : "create failed" };
  }

  const [{ data: team }, { data: inviter }] = await Promise.all([
    db.from("teams").select("name").eq("id", ctx.teamId).maybeSingle(),
    db.from("members").select("display_name").eq("id", ctx.memberId).maybeSingle(),
  ]);
  const teamName = (team as { name: string } | null)?.name ?? teamSlug;
  const inviterName = (inviter as { display_name: string } | null)?.display_name ?? "Your admin";

  // Grant sign-in access + run the provisioning cascade through the shared invite core (same code
  // path the REST endpoint uses). Provisioning can never fail the invite; the only hard failure is
  // the sign-in issuance itself (no link, or the password write erroring).
  const issued = await issueMemberInvite(db, {
    teamId: ctx.teamId,
    member: {
      id: newMemberId,
      email,
      displayName: form.displayName,
      role: form.role,
      tier: "team",
    },
    teamName,
    inviterName,
    nextPath: `/t/${teamSlug}`,
    teamUrl: await resolveTeamUrl(),
    tools: form.tools ?? "all",
    manual: !useMagicLink,
    password,
    actor: { kind: "member", memberId: ctx.memberId },
  });

  if (!issued.ok) {
    // Compensating action, not a transaction: createMember writes through the DbClient adapter while
    // the password write hits auth_users via raw runSql (lib/db/pg/pool) — different connections, so
    // there's no single SQL transaction. Only the manual (password) path can leave an orphaned
    // 'invited' member with no way to sign in; roll it back. A magic-link issuance failure leaves the
    // member in place (the admin can retry) — matching the parent branch's behavior.
    if (!useMagicLink) {
      await rollbackMemberCreation(db, ctx.teamId, newMemberId, {
        actor: { kind: "member", memberId: ctx.memberId },
      });
    }
    return { ok: false, error: issued.error };
  }

  // Best-effort — the company graph is a derived context surface, not the source of truth; a
  // transient sync hiccup must never block onboarding a real person.
  try {
    await syncMemberActor(db, ctx.teamId, newMemberId);
  } catch (e) {
    console.error("[company-graph] actor sync failed on invite:", e instanceof Error ? e.message : e);
  }

  revalidatePath(`/t/${teamSlug}/admin/members`);

  if (issued.mode === "magic-link") {
    return {
      ok: true,
      mode: "magic-link",
      email,
      emailDelivered: issued.emailDelivered,
      ...(issued.loginUrl ? { loginUrl: issued.loginUrl } : {}),
      provisioning: issued.provisioning,
    };
  }

  return {
    ok: true,
    mode: "manual",
    reason: form.manualInvite ? "admin-choice" : "no-mail",
    email,
    password: issued.password,
    inviteMessage: issued.inviteMessage,
    provisioning: issued.provisioning,
  };
}

export type ProvisioningAvailability = Array<{
  tool: ProvisioningTool;
  configured: boolean;
  reason?: string;
}>;

/**
 * Per-tool provisioning availability for the invite UI (admins only) — which tools are wired up
 * (checkbox enabled + checked) vs not (disabled + the reason shown). Admin-gated wrapper over the
 * `getProvisioningAvailability` lib read; returns an empty list for a non-admin.
 */
export async function getProvisioningAvailabilityAction(
  teamSlug: string
): Promise<ProvisioningAvailability> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return [];
  return getProvisioningAvailability(adminClient(), ctx.teamId);
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
