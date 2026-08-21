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

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:decisions:get`, 60))) {
    return errorResponse("rate_limited", "60 pulls/min per key", 429);
  }

  const since = new URL(req.url).searchParams.get("since") || "1970-01-01T00:00:00Z";

  try {
    // ENFB-2 §2.2: the feed serves rationale/impact prose — the caller's oracle set + posture
    // compile into the window (fail closed: a resolution error is the catch's 500).
    const { visibleItemIds } = await import("@/lib/access/enforce");
    const vis = await visibleItemIds(db, { teamId: auth.teamId, memberId: auth.memberId });
    if (vis.error) return errorResponse("internal", "visibility resolution failed", 500);
    const decisions = await getDecisionWriteback(db, auth.teamId, auth.memberTier, since, {
      visibleItemIds: vis.ids,
      teamPosture: auth.memberTier === "team",
      // Member-only route (AUDITFIX-1 §2a): authenticateApiKey accepts `aios_` member keys only —
      // an `aiosd_` delegated token cannot authenticate here (lib/api/auth.ts).
      principal: "member" as const,
    });
    return Response.json({ decisions, next_cursor: null });
  } catch (e) {
    return errorResponse("internal", e instanceof Error ? e.message : "writeback failed", 500);
  }
}
