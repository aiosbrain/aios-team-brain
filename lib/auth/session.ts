import "server-only";
import { cookies } from "next/headers";
import { isPostgresBackend } from "@/lib/db/backend";
import { supabaseAuthClient } from "./supabase-auth";
import { SESSION_COOKIE, verifySession, type SessionUser } from "./pg-session";

export type { SessionUser } from "./pg-session";

/**
 * Backend-agnostic "who is signed in?" — the single entry point every server
 * component / route handler uses instead of `supabase.auth.getUser()`.
 *  • supabase backend → Supabase Auth session
 *  • postgres backend → signed session cookie (lib/auth/pg-session)
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (isPostgresBackend()) {
    const store = await cookies();
    const token = store.get(SESSION_COOKIE)?.value;
    return token ? verifySession(token) : null;
  }
  const supabase = await supabaseAuthClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.email ? { id: user.id, email: user.email } : null;
}

/** Clear the session on the active backend. */
export async function signOut(): Promise<void> {
  if (isPostgresBackend()) {
    const store = await cookies();
    store.delete(SESSION_COOKIE);
    return;
  }
  const supabase = await supabaseAuthClient();
  await supabase.auth.signOut();
}
