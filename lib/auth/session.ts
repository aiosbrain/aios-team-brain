import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession, type SessionUser } from "./pg-session";

export type { SessionUser } from "./pg-session";

/**
 * "Who is signed in?" — the single entry point every server component / route
 * handler uses. Reads the signed session cookie (lib/auth/pg-session).
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  return token ? verifySession(token) : null;
}

/** Clear the session. */
export async function signOut(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
