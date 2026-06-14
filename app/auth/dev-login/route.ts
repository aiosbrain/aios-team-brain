import { type NextRequest, NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase/server";
import { adminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * DEV-ONLY one-click login. Visit:
 *   /auth/dev-login?email=alex@demo.aios.local&next=/t/demo
 *
 * Unlike a pasted magic-link URL, this mints AND verifies the token in a single
 * server request, then sets the session cookie and redirects — so it never goes
 * stale and isn't single-use-fragile. Hard-disabled outside development.
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
  const fail = (why: string) => NextResponse.redirect(new URL(`/login?error=${why}`, base));

  const admin = adminClient();

  // 1. Ensure a confirmed auth user exists.
  const { data: list } = await admin.auth.admin.listUsers();
  let userId = (list?.users ?? []).find(
    (u) => (u.email ?? "").toLowerCase() === email.toLowerCase()
  )?.id;
  if (!userId) {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data?.user) return fail("devlogin_user");
    userId = data.user.id;
  }

  // 2. Link any invited member row for this email.
  await admin
    .from("members")
    .update({ auth_user_id: userId, status: "active" })
    .eq("email", email)
    .is("auth_user_id", null)
    .neq("status", "disabled");

  // 3. Mint + verify in one shot; serverClient writes the session cookie.
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr || !link?.properties?.hashed_token) return fail("devlogin_link");

  const supabase = await serverClient();
  const { error } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: link.properties.hashed_token,
  });
  if (error) return fail("devlogin_verify");

  return NextResponse.redirect(new URL(safeNext, base));
}
