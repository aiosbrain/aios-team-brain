import { NextRequest } from "next/server";
import { adminClient } from "@/lib/supabase/admin";
import { rateLimit } from "@/lib/api/rate-limit";
import { setMemberSecret } from "@/lib/member-secrets/manage";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import { consumeSlackOAuthState } from "@/lib/auth/slack-oauth-state";

export const runtime = "nodejs";

/**
 * Slack OAuth redirect target (browser, NO API key). The member/team are recovered ONLY from the
 * signed single-use `state` — never a parameter. Flow: verify+consume state → exchange `code` via
 * oauth.v2.access → re-validate the user token with auth.test (mirrors the paste path) → store
 * encrypted in member_secrets + capture identity → render an HTML page. The token NEVER appears in
 * any HTML response and is never logged.
 *   GET ?code&state  (or ?error&state on denial)
 */

function htmlPage(status: number, heading: string, detail: string): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${heading}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#1a1a1a}
h1{font-size:1.25rem}p{color:#555}</style></head>
<body><h1>${heading}</h1><p>${detail}</p></body></html>`;
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const denied = () =>
  htmlPage(400, "Slack connection failed", "Authorization was denied or the link is invalid. You can close this tab and try connecting again.");

interface OAuthAccess {
  ok: boolean;
  error?: string;
  authed_user?: { id?: string; access_token?: string };
  team?: { id?: string; name?: string };
}
interface AuthTest {
  ok: boolean;
  error?: string;
  user_id?: string;
  user?: string;
  team?: string;
  team_id?: string;
}

async function exchangeCode(code: string, clientId: string, clientSecret: string, redirect: string): Promise<OAuthAccess> {
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirect }),
  });
  return (await res.json()) as OAuthAccess;
}

async function slackAuthTest(token: string): Promise<AuthTest> {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()) as AuthTest;
}

export async function GET(req: NextRequest) {
  const supabase = adminClient();
  const params = new URL(req.url).searchParams;
  const code = params.get("code");
  const state = params.get("state");
  const errorParam = params.get("error");

  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await rateLimit(supabase, `slack-oauth:callback:${clientIp}`, 30))) {
    return htmlPage(429, "Too many attempts", "Please wait a minute and try connecting Slack again.");
  }

  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const redirect = process.env.SLACK_OAUTH_REDIRECT;
  if (!clientId || !clientSecret || !redirect || !process.env.AUTH_SECRET) {
    return htmlPage(500, "Slack connection unavailable", "Slack OAuth is not configured on this instance.");
  }

  // Verify + consume the single-use state FIRST (CSRF/replay guard). Invalid/expired/used → stop.
  const bound = await consumeSlackOAuthState(supabase, state);
  if (!bound) return denied();

  // User declined consent (Slack sends ?error with no code): nonce already consumed, store nothing.
  if (errorParam || !code) return denied();

  const access = await exchangeCode(code, clientId, clientSecret, redirect);
  if (!access.ok || !access.authed_user?.access_token) return denied();
  const token = access.authed_user.access_token;

  // Re-validate the token independently before storing (don't trust oauth.v2.access alone) — mirrors
  // the paste path: require a working USER token (xoxp-) that auth.test accepts.
  const test = await slackAuthTest(token);
  if (!test.ok || !test.user_id || !token.startsWith("xoxp-")) {
    return htmlPage(422, "Slack connection failed", "Slack did not return a valid user token. You can close this tab and try again.");
  }

  await setMemberSecret(supabase, { teamId: bound.teamId, memberId: bound.memberId }, "slack", token, {
    slack_user_id: test.user_id,
    workspace: test.team ?? null,
    workspace_id: test.team_id ?? null,
    acquired_via: "oauth",
  });

  // Capture the member's Slack identity so resolve + `slack dm --member` work afterward (best-effort).
  const { data: m } = await supabase
    .from("members")
    .select("email")
    .eq("team_id", bound.teamId)
    .eq("id", bound.memberId)
    .maybeSingle();
  try {
    await setMemberIdentity(
      supabase,
      bound.teamId,
      bound.memberId,
      { provider: "slack", externalId: test.user_id, handle: test.user ?? "", email: (m?.email as string) ?? "" },
      { actor: { kind: "member", memberId: bound.memberId } }
    );
  } catch {
    // identity capture is best-effort; the token is stored regardless.
  }

  return htmlPage(200, "Slack connected", "Your Slack account is connected. You can close this tab and return to your workspace.");
}
