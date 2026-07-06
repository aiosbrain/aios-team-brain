"use server";

import { revalidatePath } from "next/cache";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin as requireAdmin } from "@/lib/auth/guard";
import { createMember } from "@/lib/admin/members";
import { issueApiKey as issueApiKeyPrimitive, revokeApiKey as revokeApiKeyPrimitive } from "@/lib/admin/keys";
import { adminSetPassword } from "@/lib/auth/pg-login";
import { isPasswordStrongEnough, randomPassword, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { sendInviteEmail } from "@/lib/auth/mailer";

/**
 * Create a member AND set their initial sign-in password (audit M1/M2b — replaces magic-link
 * invites). `form.password` is optional: an admin can type one, or leave it blank to get a strong
 * generated one — either way it's returned ONCE for the admin to hand to the person out-of-band
 * (same "shown once" pattern as API key issuance below), never emailed.
 */
export async function inviteMember(
  teamSlug: string,
  form: {
    email: string;
    displayName: string;
    actorHandle: string;
    role: "admin" | "lead" | "member";
    password?: string;
  }
): Promise<{ ok: boolean; password?: string; error?: string }> {
  const ctx = await requireAdmin(teamSlug);
  if (!ctx) return { ok: false, error: "admins only" };

  const password = form.password?.trim() || randomPassword();
  if (!isPasswordStrongEnough(password)) {
    return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const email = form.email.trim().toLowerCase();
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
      { actor: { kind: "member", memberId: ctx.memberId } }
    );
    await adminSetPassword(email, password);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "create failed" };
  }

  // Best-effort courtesy notification — never blocks the invite, and never carries the password.
  try {
    await sendInviteEmail(email);
  } catch (e) {
    console.error("[invite] email send failed:", e instanceof Error ? e.message : e);
  }

  revalidatePath(`/t/${teamSlug}/admin/members`);
  return { ok: true, password };
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
