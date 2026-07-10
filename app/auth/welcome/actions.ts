"use server";

import { getSessionUser } from "@/lib/auth/session";
import { setPasswordIfUnset } from "@/lib/auth/pg-login";
import { isPasswordStrongEnough, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

/**
 * Optional first-time password set, offered on the welcome screen to a member who signed in via
 * magic link and has no password yet. Not a reset (no current-password check) — `setPasswordIfUnset`
 * only writes when none exists, so this can't touch an account that already has one.
 */
export async function setInitialPassword(newPassword: string): Promise<{ ok: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "not signed in" };
  if (!isPasswordStrongEnough(newPassword)) {
    return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const set = await setPasswordIfUnset(user.id, newPassword);
  if (!set) return { ok: false, error: "a password is already set for this account" };
  return { ok: true };
}
