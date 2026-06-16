import "server-only";
import { SignJWT, jwtVerify } from "jose";

/**
 * Signed-cookie sessions for the postgres backend (no Supabase Auth). The
 * session is a short JWT (HS256) in an httpOnly cookie; `sub` is the auth_users
 * id and the payload carries the email. Requires AUTH_SECRET (>=16 chars).
 */

export const SESSION_COOKIE = "aios_session";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days
const ALG = "HS256";

export interface SessionUser {
  id: string;
  email: string;
}

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error("DB_BACKEND=postgres requires AUTH_SECRET (>=16 chars) to sign sessions.");
  }
  return new TextEncoder().encode(s);
}

export async function signSession(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: ALG })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_S}s`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] });
    if (typeof payload.sub === "string" && typeof payload.email === "string") {
      return { id: payload.sub, email: payload.email };
    }
    return null;
  } catch {
    return null;
  }
}

export function sessionCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  };
}
