import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { getCachedWorkTimeline } from "@/lib/dashboard/timeline-cache";

export const runtime = "nodejs";

/**
 * The work-timeline context layer over HTTP (brain-api v1.12): the last 7 days of team work as a
 * day → person → work ledger (GitHub commits, Linear/Plane tasks, dated docs), the SAME assembled
 * payload the dashboard panel reads — so the CLI (`aios timeline`) and other machines get it without
 * recomputing. Serve-stale-while-revalidate cache (`work_timeline_cache`).
 *
 * Tier isolation: the payload is scoped to the key's tier via `getCachedWorkTimeline` → the builder's
 * `visibleItems`/`visibleTasks` choke-points — an `external` key never receives team-tier work
 * (no RLS backstop, CLAUDE.md §5).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:timeline:get`, 60))) {
    return errorResponse("rate_limited", "60 reads/min per key", 429);
  }

  try {
    const days = await getCachedWorkTimeline(db, auth.teamId, auth.memberTier);
    return Response.json({ window_days: 7, days });
  } catch (err) {
    return errorResponse("internal", err instanceof Error ? err.message : "timeline read failed", 500);
  }
}
