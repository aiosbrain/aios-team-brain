import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loginWithPassword } from "@/lib/auth/pg-login";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/pg-session";
import { adminClient } from "@/lib/db/admin";
import { rateLimit } from "@/lib/api/rate-limit";

export const runtime = "nodejs";

// Login attempts allowed per client IP per minute (audit M2) — throttles brute-force/enumeration.
const LOGIN_RATE_PER_MIN = 10;

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  next: z.string().optional(),
});

/**
 * Email+password sign-in (audit M1/M2b — replaces the earlier passwordless flow that trusted any
 * known member email with no ownership proof). Invite-only: an admin must have created the member
 * AND set a password before anyone can sign in as them.
 *
 * The failure response is intentionally the SAME (401 `invalid_credentials`) whether the email is
 * unrecognized, has no password set, or the password is wrong — so login can't be used to enumerate
 * member emails (the passwordless flow's 403-vs-200 shape was exactly that oracle).
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 422 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_payload" }, { status: 422 });

  // Throttle by client IP before touching the DB (audit M2). x-forwarded-for's first hop is the
  // client on Railway/Vercel edge.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!(await rateLimit(adminClient(), `login:${ip}`, LOGIN_RATE_PER_MIN))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const nextParam = parsed.data.next ?? "/";
  const safeNext = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  const user = await loginWithPassword(email, parsed.data.password);
  if (!user) {
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, redirect: safeNext });
  res.cookies.set(SESSION_COOKIE, await signSession(user), sessionCookieOptions());
  return res;
}
