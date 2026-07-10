import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { getMemberSecret } from "@/lib/member-secrets/manage";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Slack connection status for the authenticated member. Member-API-key authed (member from the key,
 * never a param). Returns whether the caller is connected + the identity captured at connect time.
 * MUST NOT return the token — that is owner-only via GET /api/v1/me/slack-token.
 *   GET → { connected, slack_user_id, workspace }
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:slack-oauth:status`, 60))) {
    return errorResponse("rate_limited", "60 reads/min per key", 429);
  }

  const rec = await getMemberSecret(db, auth.teamId, auth.memberId, "slack");
  return Response.json(
    {
      connected: !!rec,
      slack_user_id: rec?.meta.slack_user_id ?? null,
      workspace: rec?.meta.workspace ?? null,
    },
    { headers: NO_STORE }
  );
}
