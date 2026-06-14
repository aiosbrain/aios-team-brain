/**
 * dev-login.ts — mint a one-click magic-link URL for a demo member, bypassing
 * email/Mailpit entirely. Local development only.
 *
 * Why this exists: the login form is invite-only (signInWithOtp with
 * shouldCreateUser:false), so an email with no matching auth.users row gets no
 * magic link and no error. This script ensures the auth user exists + is
 * confirmed, links the member row, and prints a URL you can paste straight into
 * the browser to land logged-in on the team dashboard.
 *
 * Usage:
 *   npx tsx scripts/dev-login.ts [email] [team-slug]
 *   npm run dev:login            # defaults: alex@demo.aios.local, team "demo"
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (source .env.local)");
  process.exit(1);
}
const APP = process.env.APP_URL || "http://127.0.0.1:3000";
const email = process.argv[2] || "alex@demo.aios.local";
const teamSlug = process.argv[3] || "demo";

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function main() {
  // 1. Ensure a confirmed auth user exists for this email.
  const { data: list } = await supabase.auth.admin.listUsers();
  let userId = (list?.users ?? []).find(
    (u) => (u.email ?? "").toLowerCase() === email.toLowerCase()
  )?.id;
  if (!userId) {
    const { data, error } = await supabase.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data?.user) throw new Error(`createUser ${email}: ${error?.message}`);
    userId = data.user.id;
  }

  // 2. Link any invited member row for this email (no-op if already linked).
  await supabase
    .from("members")
    .update({ auth_user_id: userId, status: "active" })
    .eq("email", email)
    .is("auth_user_id", null)
    .neq("status", "disabled");

  // 3. Generate a magic-link token and build the app's own confirm URL
  //    (the SSR /auth/confirm route verifies token_hash + type).
  const { data, error } = await supabase.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${APP}/auth/confirm?next=/t/${teamSlug}` },
  });
  if (error || !data?.properties?.hashed_token) {
    throw new Error(`generateLink ${email}: ${error?.message ?? "no token"}`);
  }
  const loginUrl = `${APP}/auth/confirm?token_hash=${data.properties.hashed_token}&type=magiclink&next=/t/${teamSlug}`;

  console.log(`\nOne-click login for ${email} (team: ${teamSlug}) — paste into your browser:\n`);
  console.log(loginUrl);
  console.log("\n(Link is single-use and expires per Supabase OTP settings. Re-run for a fresh one.)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
