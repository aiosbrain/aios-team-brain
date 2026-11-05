import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin } from "@/lib/auth/guard";
import {
  createGoogleDriveOAuthState,
  GDRIVE_OAUTH_BINDING_COOKIE,
  gdriveOAuthBindingCookieOptions,
  newGoogleDriveOAuthBinding,
} from "@/lib/auth/gdrive-oauth-state";
import { gdriveRequestScopes, isGdriveGrantMode } from "@/lib/integrations/gdrive-grant-policy";

export const runtime = "nodejs";

/**
 * Admin-only OAuth start. The consent mode (`files` = per-file `drive.file`, `folders` = explicit
 * `drive.readonly` discovery) is required, signed into the one-use state, and requests EXACTLY that
 * mode's scopes: no `include_granted_scopes`, so a per-file consent never silently inherits an
 * earlier broad grant (AIO-1167 R43 F3). The callback still verifies what Google actually granted.
 */

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const teamSlug = params.get("team") ?? "";
  const name = (params.get("name") ?? "google-drive").trim().slice(0, 120);
  const mode = params.get("mode");
  const auth = await requireTeamAdmin(teamSlug);
  if (!auth) return new Response("admins only", { status: 403 });
  if (!isGdriveGrantMode(mode)) {
    return new Response("Choose per-file access or folder discovery to connect Google Drive", { status: 400 });
  }
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_DRIVE_OAUTH_REDIRECT;
  if (!clientId || !redirectUri || !process.env.AUTH_SECRET) {
    return new Response("Google Drive OAuth is not configured on this instance", { status: 503 });
  }
  const db = adminClient();
  await db.from("oauth_states").delete().eq("member_id", auth.memberId).eq("provider", "gdrive")
    .lt("expires_at", new Date().toISOString());
  // The state is redeemable only from this browser: the binding goes out as an HttpOnly cookie and
  // only its hash is signed into the state the browser carries to Google and back.
  const browserBinding = newGoogleDriveOAuthBinding();
  const state = await createGoogleDriveOAuthState(db, {
    teamId: auth.teamId,
    memberId: auth.memberId,
    integrationName: name || "google-drive",
    teamSlug,
    mode,
    browserBinding,
  });
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: gdriveRequestScopes(mode).join(" "),
    state,
  }).toString();
  const response = NextResponse.redirect(authorize);
  response.cookies.set(GDRIVE_OAUTH_BINDING_COOKIE, browserBinding, gdriveOAuthBindingCookieOptions());
  return response;
}
