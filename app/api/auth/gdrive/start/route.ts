import { NextRequest, NextResponse } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin } from "@/lib/auth/guard";
import {
  createGoogleDriveOAuthState,
  GDRIVE_OAUTH_BINDING_COOKIE,
  gdriveOAuthBindingCookieOptions,
  newGoogleDriveOAuthBinding,
} from "@/lib/auth/gdrive-oauth-state";

export const runtime = "nodejs";

const FILE_SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"];
const DISCOVERY_SCOPES = ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.readonly"];

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const teamSlug = params.get("team") ?? "";
  const name = (params.get("name") ?? "google-drive").trim().slice(0, 120);
  const mode = params.get("mode") === "files" ? "files" : "folders";
  const auth = await requireTeamAdmin(teamSlug);
  if (!auth) return new Response("admins only", { status: 403 });
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
    browserBinding,
  });
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    scope: (mode === "files" ? FILE_SCOPES : DISCOVERY_SCOPES).join(" "),
    state,
  }).toString();
  const response = NextResponse.redirect(authorize);
  response.cookies.set(GDRIVE_OAUTH_BINDING_COOKIE, browserBinding, gdriveOAuthBindingCookieOptions());
  return response;
}
