import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { setMemberSecret, getMemberSecret, deleteMemberSecret } from "@/lib/member-secrets/manage";
import { setMemberIdentity } from "@/lib/identity/member-identities";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The owner's OWN Slack USER token (xoxp) for "act as me" — the personal counterpart to the
 * team's read-only Slack ingestion. Owner-only BY CONSTRUCTION: the member id comes from the
 * authenticated API key (`auth.memberId`), never a parameter — a key can only touch its own
 * token. The token is stored encrypted (member_secrets) and returned only over this TLS endpoint,
 * never logged.
 *
 *   GET    → { connected, token, slack_user_id, workspace }  (the agent fetches its own token)
 *   POST   {token}  → validate (auth.test) + store + capture identity; reports identity_status
 *   DELETE → disconnect
 */
async function slackAuthTest(token: string) {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()) as { ok: boolean; error?: string; user_id?: string; user?: string; team_id?: string; team?: string };
}

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:me:slack-token`, 60))) {
    return errorResponse("rate_limited", "60 reads/min per key", 429);
  }
  const rec = await getMemberSecret(db, auth.teamId, auth.memberId, "slack");
  if (!rec) {
    return Response.json({ connected: false, error: "not_connected" }, { status: 404, headers: NO_STORE });
  }
  return Response.json(
    {
      connected: true,
      token: rec.secret,
      slack_user_id: rec.meta.slack_user_id ?? null,
      workspace: rec.meta.workspace ?? null,
    },
    { headers: NO_STORE }
  );
}

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:me:slack-token:write`, 20))) {
    return errorResponse("rate_limited", "20 writes/min per key", 429);
  }

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("bad_request", "expected JSON body { token }", 400);
  }
  const token = (body.token ?? "").trim();
  if (!token.startsWith("xoxp-")) {
    return errorResponse("bad_request", "token must be a Slack USER token (xoxp-…)", 400);
  }

  const test = await slackAuthTest(token);
  if (!test.ok || !test.user_id) {
    return errorResponse("invalid_token", `Slack rejected the token (${test.error ?? "auth.test failed"})`, 422);
  }

  await setMemberSecret(db, { teamId: auth.teamId, memberId: auth.memberId }, "slack", token, {
    slack_user_id: test.user_id,
    workspace: test.team ?? null,
    workspace_id: test.team_id ?? null,
    acquired_via: "paste",
  });

  // Capture the member's Slack identity so `slack dm --member` + resolve work afterward.
  const { data: m } = await db
    .from("members")
    .select("email")
    .eq("team_id", auth.teamId)
    .eq("id", auth.memberId)
    .maybeSingle();
  let identityStatus: "linked" | "conflict" | "pending" = "pending";
  try {
    const result = await setMemberIdentity(
      db,
      auth.teamId,
      auth.memberId,
      { provider: "slack", externalId: test.user_id, handle: test.user ?? "", email: (m?.email as string) ?? "" },
      // NOT `explicit`: that bypasses the unlink fence, and an admin's unlink must stay in force until an ADMIN
      // relinks (AIO-1170 P2-03). A fenced account reports `conflict`; the credential is still saved.
      { actor: { kind: "member", memberId: auth.memberId } }
    );
    identityStatus = result.conflict ? "conflict" : "linked";
  } catch {
    // Credential storage succeeded; identity attribution remains pending.
  }

  return Response.json(
    { ok: true, slack_user_id: test.user_id, workspace: test.team ?? null, identity_status: identityStatus },
    { headers: NO_STORE }
  );
}

export async function DELETE(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);
  const db = adminClient();
  await deleteMemberSecret(db, { teamId: auth.teamId, memberId: auth.memberId }, "slack");
  return Response.json({ ok: true, connected: false }, { headers: NO_STORE });
}
