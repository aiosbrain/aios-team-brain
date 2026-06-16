import { type NextRequest, NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";
import { isPostgresBackend } from "@/lib/db/backend";
import { redeemMagicToken } from "@/lib/auth/pg-login";
import { signSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth/pg-session";

export const runtime = "nodejs";

/**
 * Magic-link / OTP verification (per current @supabase/ssr guidance:
 * verifyOtp with token_hash). On first login we link the invited member
 * row to the auth user — that write needs the admin client because the
 * user has no RLS-visible membership until the link exists.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = searchParams.get("next") ?? "/";
  // only allow internal redirects
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  // Redirect back to the SAME host the caller used. Next dev reports
  // request.url as localhost even when the browser is on 127.0.0.1; redirecting
  // to a different host would drop the auth cookie (host-only) and bounce the
  // user to /login. Preserve the request Host (or x-forwarded-host behind a proxy).
  const fwdHost = request.headers.get("x-forwarded-host");
  const host = fwdHost ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  const base = host ? `${proto}://${host}` : request.url;

  // Postgres backend: verify our own single-use magic-link token, link the
  // member, and set the signed session cookie.
  if (isPostgresBackend()) {
    const token = searchParams.get("token");
    if (token) {
      const result = await redeemMagicToken(token);
      if (result) {
        const dest = result.nextPath.startsWith("/") && !result.nextPath.startsWith("//")
          ? result.nextPath
          : "/";
        const res = NextResponse.redirect(new URL(dest, base));
        res.cookies.set(SESSION_COOKIE, await signSession(result.user), sessionCookieOptions());
        return res;
      }
    }
    return NextResponse.redirect(new URL("/login?error=invalid_link", base));
  }

  if (tokenHash && type) {
    const supabase = await serverClient();
    const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

    if (!error) {
      const user = data.user ?? (await supabase.auth.getUser()).data.user;
      if (user?.email) {
        // First login: claim the invited member row(s) for this email.
        // Also flips status invited→active so RLS membership starts working.
        const admin = adminClient();
        await admin
          .from("members")
          .update({ auth_user_id: user.id, status: "active" })
          .eq("email", user.email)
          .is("auth_user_id", null)
          .neq("status", "disabled");
      }
      return NextResponse.redirect(new URL(safeNext, base));
    }
  }

  return NextResponse.redirect(new URL("/login?error=invalid_link", base));
}
