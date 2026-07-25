import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import { visibleGroupIds, type AccessTier } from "@/lib/graph/group";
import { purgeArcCacheKey, staleArcCache } from "@/lib/graph/arc-cache";
import { bustTeamTimeline, purgeTimelineCacheTier } from "@/lib/dashboard/timeline-cache";
import { evictArcMemoryCache } from "@/lib/graph/arcs";

/**
 * The single place a tier reclassification fans out from (Pass-1 review M1).
 *
 * `items.access` is the source of truth, but several surfaces have already COMMITTED the old tier to
 * their own storage by the time it changes: rows that inherit the tier as their own column, and caches
 * holding text derived from the item. With no RLS backstop (CLAUDE.md §5) each of those keeps serving
 * the old tier on its own schedule, so healing `items.access` alone closes the leak on the retrieval
 * path and leaves it open everywhere else for up to the cache TTL.
 *
 * Both `ingestItem` paths (unchanged re-push and changed body) route through here, so the fan-out can't
 * drift between them — the changed path is exactly where the previous fix forgot to look.
 */

/** Tier-carrying tables whose rows inherit the containing item's `access` (keyed by `source_item_id`).
 *  `decisions` is deliberately absent: a decision row's audience is a per-row wire field, not inherited
 *  (see the decisions-audience data-mechanics test). Anything added here must be tier-filtered on read. */
const INHERITING_TABLES = ["tasks", "extracted_facts", "stakeholder_mentions"] as const;

export interface Reclassification {
  teamId: string;
  itemId: string;
  from: AccessTier | null;
  to: AccessTier;
  /** Connector that pushed the change, for the audit trail. */
  source: unknown;
}

/**
 * Cascade a tier change to the rows that inherit it, invalidate the tier-scoped caches, and audit it.
 *
 * The cache handling is ASYMMETRIC, and that asymmetry is the whole point:
 *   • NARROWING (external→team) — the external-tier payloads contain content that must no longer be
 *     visible there. They are PURGED, because both cache layers serve stale-while-revalidate: a mere
 *     stale-mark still hands the old payload to the next external viewer.
 *   • WIDENING (team→external) — the external payloads are merely INCOMPLETE. Nothing leaked, so a
 *     stale-mark is right; purging would force a cold LLM re-synthesis for no isolation gain.
 * The team-tier rows never need purging in either direction: a team viewer may see both tiers, so the
 * set of content they may read is unchanged by a reclassification.
 */
export async function propagateReclassification(
  db: DbClient,
  teamSlug: string,
  change: Reclassification
): Promise<void> {
  for (const table of INHERITING_TABLES) {
    const { error } = await db
      .from(table)
      .update({ audience: change.to })
      .eq("source_item_id", change.itemId);
    // NOT best-effort: a row left at the old tier in a tier-filtered table IS the leak. Fail the push
    // so the connector retries, rather than reporting success over a half-applied reclassification.
    if (error) throw new Error(`${table} audience cascade failed: ${error.message}`);
  }

  const narrowing = change.from === "external" && change.to === "team";
  // Per-process memory fronts both Postgres caches; evict for the whole team either way (a needless
  // recompute is cheap, and the eviction is the only thing that stops THIS process serving a warm copy).
  evictArcMemoryCache(teamSlug);
  if (narrowing) {
    const externalArcKey = visibleGroupIds(teamSlug, "external").slice().sort().join(",");
    await purgeArcCacheKey(db, change.teamId, externalArcKey);
    await purgeTimelineCacheTier(db, change.teamId, "external");
  }
  // Both directions, and a backstop under the purges above (they swallow their own errors): a stale
  // mark bounds any surviving row to a single TTL instead of a full 4h/5min window of serving it.
  await staleArcCache(db, change.teamId);
  await bustTeamTimeline(db, change.teamId);

  // Audit the rare reclassification so the tier change isn't silent. Rare enough not to reintroduce the
  // per-tick unbounded audit growth that removed the `item.unchanged` row (audit M4).
  await audit(db, {
    team_id: change.teamId,
    actor_kind: "system",
    member_id: null,
    action: "item.access_healed",
    target_type: "items",
    target_id: change.itemId,
    meta: { from: change.from, to: change.to, source: change.source ?? null },
  });
}
