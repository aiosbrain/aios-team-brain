import { NextRequest } from "next/server";
import { serverClient } from "@/lib/db/server";
import { adminClient } from "@/lib/db/admin";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/api/schemas";
import { freshnessWire } from "@/lib/freshness";
import { getCachedWorkTimeline } from "@/lib/dashboard/timeline-cache";
import { mostRecentPerPerson } from "@/lib/dashboard/timeline-group";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Dashboard "Working On" data — each person's MOST RECENT day of work, collapsed from the SAME
 * work-timeline the Pulse Timeline disclosure renders (`getCachedWorkTimeline` → `work_timeline_cache`,
 * SWR), so Home and the Timeline are identical. Fetched by the client card so a cold-cache rebuild never
 * blocks the home SSR. Session-authed; tier decides visibility (`visibleItems`/`visibleTasks`, the sole
 * enforcement). Best-effort empty when there's no recent work.
 */
export async function GET(req: NextRequest) {
  const rls = await serverClient();
  const user = await getSessionUser();
  if (!user) return errorResponse("unauthorized", "sign in required", 401);

  const teamSlug = new URL(req.url).searchParams.get("team");
  if (!teamSlug) return errorResponse("invalid_payload", "team is required", 422);

  const { data: team } = await rls.from("teams").select("id").eq("slug", teamSlug).maybeSingle();
  if (!team) return errorResponse("forbidden", "not a member of this team", 403);
  const { data: me } = await rls
    .from("members")
    .select("id")
    .eq("team_id", team.id)
    .eq("auth_user_id", user.id)
    .eq("status", "active")
    .maybeSingle();
  if (!me) return errorResponse("forbidden", "not a member of this team", 403);

  // PRET-4 §1a: posture, not the record.
  const { resolveViewerPosture } = await import("@/lib/access/posture");
  const tier = await resolveViewerPosture(adminClient(), team.id, (me as { id: string }).id);
  // §5.8: the session member is the principal — an enforcing team serves their visibility variant.
  const { days, freshness } = await getCachedWorkTimeline(adminClient(), team.id, tier, (me as { id: string }).id);
  const people = mostRecentPerPerson(days);
  // WAS `new Date()` over a 5-min-TTL cache that also serves PAST the TTL while rebuilding — so this
  // reported a stale ledger as current. Now the cache row's own time (R2/M6).
  return Response.json({ people, ...freshnessWire(freshness) });
}
