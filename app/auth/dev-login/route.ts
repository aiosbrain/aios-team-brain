import { type NextRequest, NextResponse } from "next/server";
import { ensureAuthUser, linkMemberByEmail } from "@/lib/auth/pg-login";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/pg-session";

export const runtime = "nodejs";

/**
 * DEV-ONLY one-click login. Visit:
 *   /auth/dev-login?email=alex@demo.aios.local&next=/t/demo
 *
 * Mints AND sets the session in a single server request — never goes stale and
 * isn't single-use-fragile. Hard-disabled outside development.
 */
export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_LOGIN !== "1") {
    return new NextResponse("dev-login is disabled", { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const email = searchParams.get("email") || "alex@demo.aios.local";
  const nextParam = searchParams.get("next") ?? "/t/demo";
  const safeNext = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/";

  // Stay on the host the caller used (cookie is host-only; see confirm/route.ts).
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const base = host ? `${proto}://${host}` : request.url;

  // Create the local auth user, link the member, set the signed session cookie.
  const id = await ensureAuthUser(email);
  await linkMemberByEmail(id, email);
  const token = await signSession({ id, email });
  const res = NextResponse.redirect(new URL(safeNext, base));
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  return res;
}
