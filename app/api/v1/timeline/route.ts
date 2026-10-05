import { NextRequest } from "next/server";
import { adminClient } from "@/lib/db/admin";
import { authenticateApiKey } from "@/lib/api/auth";
import { rateLimit } from "@/lib/api/rate-limit";
import { errorResponse } from "@/lib/api/schemas";
import { getCachedWorkTimeline } from "@/lib/dashboard/timeline-cache";

export const runtime = "nodejs";

/**
 * The work-timeline context layer over HTTP (documented in brain-api v1.16): the last 7 days of team work as a
 * day → person → work ledger (GitHub commits, Linear/Plane tasks, dated docs), the SAME assembled
 * payload the dashboard panel reads — so the CLI (`aios timeline`) and other machines get it without
 * recomputing. Serve-stale-while-revalidate cache (`work_timeline_cache`).
 *
 * Access (TIERRET-1, CLAUDE.md §5 — no RLS backstop): `getCachedWorkTimeline` resolves the key's member
 * through the ONE admission resolver (`lib/access/admission.ts`) and serves its
 * `adm:<class>:<tier>:<hash>` variant (payload v17). An admitted member (active human/standing agent)
 * receives exactly its membership: evidence from oracle-visible items, sourced tasks whose source item it
 * can see, hand-entered tasks by Everyone-or-grants, and meetings whose transcript it can see — at
 * either posture, with no label ceiling. An active connector/offroster key is the LEGACY arm and keeps
 * its pre-TIERRET posture rule. An admission error throws into the 500 below; nothing is cached.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth) return errorResponse("unauthorized", "invalid API key or team", 401);

  const db = adminClient();
  if (!(await rateLimit(db, `${auth.apiKeyId}:timeline:get`, 60))) {
    return errorResponse("rate_limited", "60 reads/min per key", 429);
  }

  try {
    // Payload ONLY. `getCachedWorkTimeline` returns `{ days, freshness }`, and the freshness envelope is
    // deliberately NOT on the v1 wire — putting it here would require a later brain-api bump
    // plus the canonical doc in aios-workspace). Destructured rather than passed through: `Response.json`
    // takes `any`, so serializing the whole object type-checks and silently nests `days` one level deeper,
    // breaking every v1.12 consumer (`aios timeline`, MCP). Caught by review, not by tsc.
    // §5.8: the member key's principal — on an enforcing team this serves the member's visibility
    // variant, never the full-tier row. (Delegated aiosd_ bearers never reach here: the aios_ regex
    // rejects the prefix as malformed → 401, fail closed.)
    const { days } = await getCachedWorkTimeline(db, auth.teamId, auth.memberTier, auth.memberId);
    return Response.json({ window_days: 7, days });
  } catch (err) {
    return errorResponse("internal", err instanceof Error ? err.message : "timeline read failed", 500);
  }
}
