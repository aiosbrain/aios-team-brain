import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleGroupIds } from "@/lib/graph/group";
import { purgeArcCacheKey, staleArcCache } from "@/lib/graph/arc-cache";
import { bustTeamTimeline, purgeTimelineCacheTier } from "@/lib/dashboard/timeline-cache";
import { evictArcMemoryCache, evictScopedArcMemory, evictTeamPartitionArcMemory } from "@/lib/graph/arcs";

/**
 * Tier-scoped cache invalidation, in the lowest layer both writers can reach: `lib/ingest` (which owns
 * `items.access`) and `lib/graph` (which owns the Graphiti groups the arcs are synthesized FROM).
 *
 * It lives here rather than inside either one because closing a reclassification leak needs BOTH to
 * call it, at two different times — see the ordering note below.
 */

/**
 * Drop every external-tier cached payload for a team, hard.
 *
 * Called TWICE for one reclassification, and both calls are load-bearing:
 *
 *  1. **When `items.access` is narrowed** (`lib/ingest/reclassify`) — the external `arc_cache` /
 *     `work_timeline_cache` rows hold text derived from the item under its old tier. Both read paths are
 *     serve-stale-while-revalidate, so marking them stale still hands the old payload to the next
 *     external viewer; they have to go.
 *
 *  2. **When the graph cleanup for that tier change completes** (`lib/graph/run`) — and this is the one
 *     that is easy to miss. Arcs are synthesized from the Graphiti EXTERNAL GROUP, which the projector
 *     only cleans on its next tick. In between, step 1's purge turns a cold miss into an inline
 *     re-synthesis over a still-dirty group, and `commitArcs` stamps that result FRESH — so the purge
 *     alone can end up EXTENDING the exposure to a full 4h TTL instead of ending it. Purging again once
 *     the group is verified clean is what actually closes it (and mops up any SWR rebuild that was
 *     already in flight over pre-reclassification data when step 1 ran).
 *
 * The team-tier rows are deliberately left alone: a team viewer may read both tiers, so the set of
 * content they are allowed to see doesn't change when an item moves between tiers.
 */
export async function purgeExternalTierCaches(
  db: DbClient,
  teamId: string,
  teamSlug: string
): Promise<void> {
  // Per-process memory fronts both Postgres layers. Evicted for the whole team (a needless recompute is
  // cheap) — this is the only thing that stops THIS process serving a warm copy. Other replicas keep
  // theirs until their own TTL; that per-process bound is the documented design limit.
  evictArcMemoryCache(teamSlug);
  evictScopedArcMemory(teamId); // PCCC-7: id-namespaced p: keys — invisible to the slug eviction
  await evictTeamPartitionArcMemory(db, teamId); // PPARC-2: g: keys carry only the group id
  const externalArcKey = visibleGroupIds(teamSlug, "external").slice().sort().join(",");
  await purgeArcCacheKey(db, teamId, externalArcKey);
  await purgeTimelineCacheTier(db, teamId, "external");
  // Backstop under both purges (they swallow their own errors) and cover the team rows: a stale mark
  // bounds anything that survived to a single TTL rather than a full window of serving it.
  await staleArcCache(db, teamId);
  await bustTeamTimeline(db, teamId);
}
