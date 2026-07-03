import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { getDecisionWriteback } from "@/lib/sync/decisions";

export const runtime = "nodejs";

/**
 * Decision writeback for `aios pull` — thin wrapper around `getDecisionWriteback`
 * (the filter/tier logic lives there so it's unit-testable against a real DB).
 * Mirrors `GET /api/v1/tasks`.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const supabase = adminClient();
  if (!(await rateLimit(supabase, `${auth.apiKeyId}:decisions:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const since = new URL(req.url).searchParams.get("since") || "1970-01-01T00:00:00Z";

  try {
    const decisions = await getDecisionWriteback(supabase, auth.teamId, auth.memberTier, since);
    return Response.json({ decisions, next_cursor: null });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "writeback failed", 500);
  }
}
