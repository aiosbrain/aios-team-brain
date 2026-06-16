import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isPostgresBackend } from "@/lib/db/backend";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/pg-session";

/**
 * Auth gate for the app shell (/t/*). Backend-aware:
 *  • supabase → refresh the Supabase session cookie and read the user
 *  • postgres → verify the signed session cookie (no refresh needed)
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isProtected = path.startsWith("/t/");

  if (isPostgresBackend()) {
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

  // Supabase: refresh session + gate.
  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", path);
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  // Exclude ALL of /api/* (routes do their own auth) and ALL of /_next/*.
  matcher: ["/((?!api/|_next/|favicon.ico).*)"],
};
