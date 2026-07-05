import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loginByEmail } from "@/lib/auth/pg-login";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/pg-session";
import { adminClient } from "@/lib/db/admin";
import { rateLimit } from "@/lib/api/rate-limit";

export const runtime = "nodejs";

// Login attempts allowed per client IP per minute (audit M2). Passwordless login returns 403-vs-200
// by membership, so without a throttle it's a member-email enumeration oracle. Generous enough for a
// real user retrying, tight enough to make enumeration impractical.
const LOGIN_RATE_PER_MIN = 10;

const schema = z.object({
  email: z.string().email().max(200),
  next: z.string().optional(),
});

/**
 * Direct (passwordless) sign-in. Invite-only: if the email is a recognized
 * non-disabled member we set the signed session cookie immediately; otherwise we
 * reject with 403. No email round-trip / magic link.
 *
 * SECURITY: trusts the submitted email with no ownership proof — fine only for this
 * invite-only, self-hosted instance with a known member list. See lib/auth/pg-login.loginByEmail.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 422 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_email" }, { status: 422 });

  // Throttle by client IP before touching the DB, so login can't be used to enumerate member emails
  // (audit M2). x-forwarded-for's first hop is the client on Railway/Vercel edge.
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!(await rateLimit(adminClient(), `login:${ip}`, LOGIN_RATE_PER_MIN))) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const email = parsed.data.email.trim().toLowerCase();
  const nextParam = parsed.data.next ?? "/";
  const safeNext = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  const user = await loginByEmail(email);
  if (!user) {
    // Not a recognized member — invite-only.
    return NextResponse.json({ error: "not_recognized" }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true, redirect: safeNext });
  res.cookies.set(SESSION_COOKIE, await signSession(user), sessionCookieOptions());
  return res;
}
