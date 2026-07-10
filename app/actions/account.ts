"use server";

import { redirect } from "next/navigation";
import { getSessionUser, signOut } from "@/lib/auth/session";
import { changePassword } from "@/lib/auth/pg-login";
import { isPasswordStrongEnough, MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

/**
 * Self-service password change for the signed-in user (any team, any role — this is account-level,
 * not team-scoped). The current password is REQUIRED and verified server-side; `authUserId` comes
 * from the caller's own signed session, never a parameter, so this can only ever change the
 * caller's own password.
 */
export async function changeMyPassword(
  currentPassword: string,
  newPassword: string
): Promise<{ ok: boolean; error?: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: "not signed in" };
  if (!isPasswordStrongEnough(newPassword)) {
    return { ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
  }

  const changed = await changePassword(user.id, currentPassword, newPassword);
  if (!changed) return { ok: false, error: "current password is incorrect" };
  return { ok: true };
}

/** Clear the session cookie and send the browser back to /login. */
export async function signOutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}
