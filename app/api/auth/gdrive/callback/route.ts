import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { requireTeamAdmin } from "@/lib/auth/guard";
import { consumeGoogleDriveOAuthState, GDRIVE_OAUTH_BINDING_COOKIE } from "@/lib/auth/gdrive-oauth-state";
import {
  IncompleteGoogleOAuthPairError,
  GoogleIdentityConflictError,
  InvalidGoogleOAuthInitiatorError,
  publishGoogleDriveOAuthCredential,
} from "@/lib/integrations/gdrive-oauth";

export const runtime = "nodejs";

function html(status: number, heading: string, detail: string): Response {
  const safe = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${safe(heading)}</title><body><main><h1>${safe(heading)}</h1><p>${safe(detail)}</p></main></body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const db = adminClient();
  const params = req.nextUrl.searchParams;
  // The browser first: a state is redeemed only alongside the binding cookie `start` set in the
  // browser that began this connection. Without it nothing is consumed, exchanged or stored.
  const bound = await consumeGoogleDriveOAuthState(
    db, params.get("state"), req.cookies.get(GDRIVE_OAUTH_BINDING_COOKIE)?.value,
  );
  if (!bound) return html(400, "Google Drive connection failed", "The authorization link is invalid, expired, or already used.");
  // Then the session: the Admin who started the connection must be the one signed in here, before
  // Google's code is exchanged. (Publication re-verifies that Admin once more, under its locks.)
  const session = await requireTeamAdmin(bound.teamSlug);
  if (!session || session.teamId !== bound.teamId || session.memberId !== bound.memberId) {
    return html(403, "Google Drive connection failed", "Sign in as the Admin who started this connection, then connect again. No credentials were stored.");
  }
  if (params.get("error") || !params.get("code")) return html(400, "Google Drive connection failed", "Authorization was denied. No credentials were stored.");
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DRIVE_OAUTH_REDIRECT;
  if (!clientId || !clientSecret || !redirectUri) return html(503, "Google Drive unavailable", "OAuth is not configured on this instance.");

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: params.get("code")!, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    cache: "no-store",
  });
  const tokens = await tokenResponse.json() as Record<string, unknown>;
  if (!tokenResponse.ok || typeof tokens.access_token !== "string") return html(422, "Google Drive connection failed", "Google did not return usable credentials. Try reconnecting.");
  const userResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
    cache: "no-store",
  });
  const user = await userResponse.json() as { sub?: string; email?: string; name?: string };
  if (!userResponse.ok || !user.sub || !user.email) return html(422, "Google Drive connection failed", "The connected Google account could not be verified.");

  try {
    await publishGoogleDriveOAuthCredential({
      teamId: bound.teamId, memberId: bound.memberId, integrationName: bound.integrationName,
      clientId, clientSecret, subject: user.sub, email: user.email, name: user.name,
      refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined,
      scopes: typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : undefined,
    });
  } catch (error) {
    if (error instanceof IncompleteGoogleOAuthPairError) {
      return html(422, "Google Drive reconnect required", "Google did not return a refresh credential for this account. Reconnect and grant offline access.");
    }
    if (error instanceof InvalidGoogleOAuthInitiatorError) {
      return html(403, "Google Drive connection failed", "The initiating Admin is no longer authorized for this team. The previous connection was left unchanged.");
    }
    if (error instanceof GoogleIdentityConflictError) {
      return html(409, "Google identity needs review", "This verified Google account conflicts with an existing manual member mapping. Review it in Admin → Members; the previous connection was left unchanged.");
    }
    return html(500, "Google Drive connection failed", "The verified credential could not be stored. The previous connection was left unchanged.");
  }
  return html(200, "Google Drive connected", `Connected ${user.email}. Return to Integrations to choose files or folders.`);
}
