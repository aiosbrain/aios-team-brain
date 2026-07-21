import { type NextRequest, NextResponse } from "next/server";
import { redeemMagicToken } from "@/lib/auth/pg-login";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/pg-session";
import { safeNextPath } from "@/lib/auth/next-path";

export const runtime = "nodejs";

/**
 * Magic-link verification. Verifies our own single-use magic-link token
 * (lib/auth/pg-login), links the invited member on first login, and sets the
 * signed session cookie.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Redirect back to the SAME host the caller used. Next dev reports
  // request.url as localhost even when the browser is on 127.0.0.1; redirecting
  // to a different host would drop the auth cookie (host-only) and bounce the
  // user to /login. Preserve the request Host (or x-forwarded-host behind a proxy).
  const fwdHost = request.headers.get("x-forwarded-host");
  const host = fwdHost ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const base = host ? `${proto}://${host}` : request.url;

  const token = searchParams.get("token");
  if (token) {
    const result = await redeemMagicToken(token);
    if (result) {
      // Re-sanitize on redeem too: the token's next_path is attacker-influenced at request time and
      // may predate the request-route's own check (or be minted by another issuer).
      const dest = safeNextPath(result.nextPath);
      // First login (an invite being activated): route through the welcome screen
      // instead of dropping straight onto the dashboard. Later logins are unaffected.
      const target = result.firstLogin ? `/auth/welcome?next=${encodeURIComponent(dest)}` : dest;
      const res = NextResponse.redirect(new URL(target, base));
      res.cookies.set(SESSION_COOKIE, await signSession(result.user), sessionCookieOptions());
      return res;
    }
  }
  return NextResponse.redirect(new URL("/login?error=invalid_link", base));
}
