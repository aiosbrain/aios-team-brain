import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/pg-session";

/**
 * Auth gate for the app shell (/t/*): verify the signed session cookie
 * (lib/auth/pg-session). No refresh needed — the cookie is self-contained.
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isProtected = path.startsWith("/t/");

  if (isProtected) {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const user = token ? await verifySession(token) : null;
    if (!user) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", path);
      return NextResponse.redirect(url);
    }
  }
  return NextResponse.next({ request });
}

export const config = {
  // Exclude ALL of /api/* (routes do their own auth) and ALL of /_next/*.
  matcher: ["/((?!api/|_next/|favicon.ico).*)"],
};
