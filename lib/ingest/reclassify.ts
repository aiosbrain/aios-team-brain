import "server-only";
import type { DbClient } from "@/lib/db/types";
import { audit } from "@/lib/api/audit";
import type { AccessTier } from "@/lib/graph/group";
import { purgeExternalTierCaches } from "@/lib/cache/tier-invalidation";
import { narrowSocialChainForItem } from "@/lib/social/store";
import { staleArcCache } from "@/lib/graph/arc-cache";
import { bustTeamTimeline } from "@/lib/dashboard/timeline-cache";

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
 *
 * ── Why this is TWO functions ────────────────────────────────────────────────────────────────────────
 * The split is an ordering requirement, not decomposition for its own sake. `ingestItem` must:
 *   1. `cascadeInheritedAudience(...)`  ← BEFORE it writes `items.access`
 *   2. write `items.access`
 *   3. `settleReclassification(...)`    ← AFTER
 * Run in that order:
 *   • step 1 throws → `items.access` is untouched, so the next sync tick still sees the tier as changed
 *     and retries the whole thing. (The other order strands the inheriting rows at the OLD tier
 *     PERMANENTLY: the retry reads the already-committed `access`, computes `accessChanged = false`, and
 *     never repairs them — a leak with no repair path and no signal beyond one 500. That is the whole
 *     reason for the split.)
 *   • step 2 throws → the inheriting rows are already at the new tier while the item is still at the old
 *     one. For a NARROWING that's stricter than required (fail-closed); for a WIDENING it's briefly
 *     wider than the item, which the source already authorized. Either way the next tick converges.
 *   • step 3 is last because it CANNOT be retried by a later push (the retry would compute
 *     `accessChanged = false`), so it must not be able to block the tier commit. It is safe there
 *     precisely because it can barely fail: every purge/stale helper swallows its own errors, the worst
 *     outcome is a cache that expires on its TTL instead of being purged, and when the graph is
 *     configured `lib/graph/run` re-purges once the tier move has left the Graphiti group anyway.
 */

/** Tier-carrying tables whose rows inherit the containing item's `access`, keyed by `source_item_id`.
 *
 *  `decisions` is deliberately absent: a decision row's audience is a per-row wire field, not inherited
 *  (see the decisions-audience data-mechanics test).
 *
 *  The social chain (`social_opportunities` → plans/variants/media/publications/analytics) also carries
 *  a denormalized `access`, but it is NOT in this list: it inherits from EVIDENCE (a jsonb
 *  `[{itemId,…}]` array), not from a `source_item_id` column, so it needs a different query shape and
 *  a re-application of the evidence CEILING rather than a straight copy. `narrowSocialChainForItem`
 *  handles it, called below.
 */
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
 * PHASE 1 — move the rows that inherit the item's tier. Call BEFORE committing `items.access` (see the
 * ordering note above). NOT best-effort: a row left at the old tier in a tier-filtered table IS the
 * leak, so a failure propagates and the push fails rather than reporting success over half a change.
 */
export async function cascadeInheritedAudience(
  db: DbClient,
  teamId: string,
  itemId: string,
  to: AccessTier
): Promise<void> {
  for (const table of INHERITING_TABLES) {
    const { error } = await db.from(table).update({ audience: to }).eq("source_item_id", itemId);
    if (error) throw new Error(`${table} audience cascade failed: ${error.message}`);
  }
  // The social chain inherits its tier from EVIDENCE rather than a `source_item_id` column, so it can't
  // join the loop above — its own writer re-applies the evidence ceiling and walks the derived rows down
  // (`lib/social/store`, keeping that table's single-writer rule intact). Narrowing only: the ceiling is
  // a limit, not a target, so widening an item never auto-publishes anything derived from it.
  if (to === "team") await narrowSocialChainForItem(db, teamId, itemId);
}

/**
 * PHASE 2 — invalidate the tier-scoped caches and audit the change. Call AFTER `items.access` is
 * committed, so a rebuild triggered by the invalidation reads the NEW tier.
 *
 * The cache handling is ASYMMETRIC, and that asymmetry is the whole point:
 *   • NARROWING (external→team) — the external-tier payloads contain content that must no longer be
 *     visible there, and both cache layers serve stale-while-revalidate, so they are PURGED.
 *   • WIDENING (team→external) — the external payloads are merely INCOMPLETE. Nothing leaked, so a
 *     stale-mark is right; purging would force a cold LLM re-synthesis for no isolation gain.
 */
export async function settleReclassification(
  db: DbClient,
  teamSlug: string,
  change: Reclassification
): Promise<void> {
  if (change.from === "external" && change.to === "team") {
    await purgeExternalTierCaches(db, change.teamId, teamSlug);
  } else {
    await staleArcCache(db, change.teamId);
    await bustTeamTimeline(db, change.teamId);
  }

  // §11 context: a tier change MUST re-partition the item's membership from ANY caller, not only
  // the push route's after() hook — a connector re-sync or internal ingestItem flips access with
  // no route, and the scheduler's converged short-circuit no longer catches it (slice-5 Codex
  // HIGH). This is the fan-out point (the comment above claims it), so the move lives here.
  // Best-effort: a reconcile failure must never fail the reclassification; idempotent.
  try {
    const { reconcileItemContext } = await import("@/lib/projects/context/reconcile-item");
    const r = await reconcileItemContext(db, change.teamId, change.itemId);
    if (!r.ok) console.warn(`[access] context re-partition after reclassification of ${change.itemId} failed: ${r.error}`);
    // CLOSEMODE-1: a human's standing exclusion survived the flip — quiet by design, but named in the
    // log so the reclassify trail shows the decision held.
    else if (r.spared) console.info(`[access] reclassification of ${change.itemId}: ${r.spared} standing exclusion(s) spared on the opposite system project`);
  } catch (e) {
    console.warn(`[access] context re-partition threw for ${change.itemId}: ${e instanceof Error ? e.message : e}`);
  }

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
