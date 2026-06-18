import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isPostgresBackend } from "@/lib/db/backend";
import { loginByEmail } from "@/lib/auth/pg-login";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/pg-session";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email().max(200),
  next: z.string().optional(),
});

/**
 * Direct (passwordless) sign-in for the postgres backend. Invite-only: if the email is a
 * recognized non-disabled member we set the signed session cookie immediately; otherwise we
 * reject with 403. No email round-trip / magic link.
 *
 * SECURITY: trusts the submitted email with no ownership proof — fine only for this
 * invite-only, self-hosted instance with a known member list. See lib/auth/pg-login.loginByEmail.
 */
export async function POST(req: NextRequest) {
  if (!isPostgresBackend()) {
    return NextResponse.json({ error: "not_applicable" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 422 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_email" }, { status: 422 });

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
