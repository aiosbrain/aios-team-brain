import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { createSlackOAuthState } from "@/lib/auth/slack-oauth-state";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

// USER scopes for "act as me" — the OAuth flow yields an `xoxp-` user token (authed_user.access_token),
// the one-click counterpart of the manual-paste path (POST /api/v1/me/slack-token). `users:read.email`
// is what lets the by-email identity auto-map work afterward.
const USER_SCOPES = "chat:write,im:write,users:read,users:read.email,reactions:write,channels:read";

/**
 * Begin one-click Slack OAuth. Member-API-key authed: the member/team come from the key, are bound
 * into a single-use signed `state`, and the browser is handed a `slack.com/oauth/v2/authorize` URL.
 *   GET → { authorize_url }
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:slack-oauth:start`, 30))) {
    return errorResponse("rate_limited", "30 starts/min per key", 429);
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const redirect = process.env.SLACK_OAUTH_REDIRECT;
  if (!clientId || !redirect || !process.env.AUTH_SECRET) {
    return errorResponse("config_error", "Slack OAuth is not configured on this instance", 500);
  }

  // Opportunistic hygiene: drop this member's expired nonces (no GC job needed for v1).
  await db.from("oauth_states").delete().eq("member_id", auth.memberId).lt("expires_at", new Date().toISOString());

  const state = await createSlackOAuthState(db, auth.teamId, auth.memberId);

  const params = new URLSearchParams({
    client_id: clientId,
    user_scope: USER_SCOPES,
    redirect_uri: redirect,
    state,
  });
  const authorize_url = `https://slack.com/oauth/v2/authorize?${params.toString()}`;

  return Response.json({ authorize_url }, { headers: NO_STORE });
}
