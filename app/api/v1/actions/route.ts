import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { actionRequestSchema, errorResponse } from "@/lib/api/schemas";
import { runAction } from "@/lib/actions";
import { createE2BSandbox } from "@/lib/actions/sandbox/e2b";

export const runtime = "nodejs";

/**
 * POST /api/v1/actions — request a policy-governed action (Organ 4). The principal is the
 * authenticated API key's member, treated as role `member` (agents act on behalf of a
 * member; elevation is gated by policy on actor/tier, not inherited admin). The brain
 * authorizes the action through lib/policy, then denies / queues for approval / executes.
 * No sandbox is wired by default, so `code.run` fails closed until one is configured.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:actions:post`, 60))) {
    return errorResponse("rate_limited", "60 actions/min per key", 429);
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return errorResponse("invalid_payload", "body must be JSON", 422);
  }
  const parsed = actionRequestSchema.safeParse(json);
  if (!parsed.success) {
    return errorResponse("invalid_payload", parsed.error.issues[0]?.message ?? "invalid", 422);
  }

  try {
    const outcome = await runAction(
      db,
      {
        teamId: auth.teamId,
        memberId: auth.memberId,
        apiKeyId: auth.apiKeyId,
        principal: { role: "member", tier: auth.memberTier, actor: auth.actorHandle },
        request: parsed.data,
      },
      // E2B runs code.run in an isolated microVM when E2B_API_KEY is set; otherwise the
      // runner reports unconfigured and code.run fails closed.
      { sandbox: createE2BSandbox() }
    );
    const status =
      outcome.status === "succeeded" ? 200
      : outcome.status === "pending_approval" ? 202
      : outcome.status === "denied" ? 403
      : 422; // failed
    return Response.json(outcome, { status });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "action failed", 500);
  }
}
