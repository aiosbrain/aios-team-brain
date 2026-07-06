import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loginByEmail } from "@/lib/auth/pg-login";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/pg-session";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email().max(200),
  next: z.string().optional(),
});

/**
 * DEV-ONLY direct (passwordless) sign-in: no email round-trip, sets the session
 * cookie immediately for any recognized member. This used to be the production
 * sign-in path — it traded ownership proof for convenience, which the code has long
 * flagged as acceptable only for a small self-hosted instance. It no longer is: the
 * real sign-in path is POST /api/auth/request-magic-link (see components/login-form).
 * Hard-disabled outside development, mirroring app/auth/dev-login/route.ts exactly.
 */
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_LOGIN !== "1") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
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
