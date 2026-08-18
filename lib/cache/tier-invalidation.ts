import "server-only";
import type { DbClient } from "@/lib/db/types";
import { visibleGroupIds, episodeGroupId } from "@/lib/graph/group";
import { EXTERNAL_SHARED_SLUG } from "@/lib/access/bootstrap";
import { purgeArcCacheKey, purgePartitionArcCache, purgeExternalShapedPartitionRows, staleArcCache } from "@/lib/graph/arc-cache";
import { bustTeamTimeline, purgeTimelineCacheTier } from "@/lib/dashboard/timeline-cache";
import { evictArcMemoryCache, evictTeamPartitionArcMemory } from "@/lib/graph/arcs";

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
  await evictTeamPartitionArcMemory(db, teamId); // PPARC-2: g: keys carry only the group id
  const externalArcKey = visibleGroupIds(teamSlug, "external").slice().sort().join(",");
  await purgeArcCacheKey(db, teamId, externalArcKey);
  // PRET-3 H3: the external PARTITION row too — external members are served from `g:<ext>` after
  // the arcs unification, and a stale-mark is not enough there (SWR hands the stale row to the
  // next reader; `purgeArcCacheKey`'s own doc). While only team-tier members read g: rows this
  // was harmless; the moment externals do, skipping it reopens the exact leak the hard-delete
  // exists to close. POINTER-resolved (diff review H4): a renamed team's external-shared
  // built-in keeps its pointer FROZEN under the old slug (the rename doctrine) — a slug-derived
  // key would delete a row that doesn't exist and leave the row externals actually read alive.
  // The slug-derived id is only the fallback for an unbootstrapped team (no pointer row yet —
  // then no g: row exists either, so the fallback is belt-and-braces, not correctness).
  const { data: extProj, error: extErr } = await db
    .from("projects")
    .select("graph_group_id")
    .eq("team_id", teamId)
    .eq("kind", "system")
    .eq("slug", EXTERNAL_SHARED_SLUG)
    .not("graph_group_id", "is", null)
    .maybeSingle();
  if (extErr) {
    // Codex diff-review H3: a swallowed read error fell back to the SLUG-derived key, which on
    // a renamed team deletes nothing and leaves the served row alive. A purge door's safe
    // direction is deleting MORE regenerable cache, never less: on error, sweep every
    // external-shaped partition row for the team — that cannot miss the served one.
    console.error(`[tier-invalidation] external pointer read failed for team ${teamId} — sweeping all external-shaped rows:`, extErr.message);
    await purgeExternalShapedPartitionRows(db, teamId);
  } else {
    const extGroup = (extProj as { graph_group_id: string } | null)?.graph_group_id ?? episodeGroupId(teamSlug, "external");
    await purgePartitionArcCache(db, teamId, extGroup);
  }
  await purgeTimelineCacheTier(db, teamId, "external");
  // Backstop under both purges (they swallow their own errors) and cover the team rows: a stale mark
  // bounds anything that survived to a single TTL rather than a full window of serving it.
  await staleArcCache(db, teamId);
  await bustTeamTimeline(db, teamId);
}
