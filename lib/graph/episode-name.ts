/**
 * Episode naming for the brain→Graphiti projection, shared by the projector, the reconcile pass, and
 * the Learning reads so every seam agrees on the format. Pure — no server-only deps.
 *
 * A large item is projected as SEVERAL episodes (chunks) so each stays small enough for Graphiti's
 * extractor (its output is hard-capped — an oversized episode overflows it and never becomes facts).
 * To stay backward-compatible, a single-chunk item keeps the plain `items:<id>` name; only a
 * multi-chunk item gets a `#<k>` suffix: `items:<id>#0`, `items:<id>#1`, …
 */

/**
 * The prefix every LEDGER-BACKED episode name carries — i.e. every episode that has a
 * `graph_episodes` row behind it.
 *
 * A constant rather than an inline literal because a second consumer now depends on it as a
 * POPULATION filter, not just a format: `lib/graph/extraction-health.newestEpisodicAtMs` asks "when
 * did the newest ledger-projected episode complete?" and must not count episodes nobody projected.
 * `lib/graph/arcs.ts` writes `correction:<arc_id>` episodes straight to Graphiti in the same group
 * with no ledger row, so without this filter a human arc correction completing would refresh the
 * extraction-liveness clock while every item episode was failing. Found by review.
 */
export const ITEM_EPISODE_PREFIX = "items:";

/** The episode name for chunk `index` of `total` chunks of item `itemId`. */
export function episodeName(itemId: string, index: number, total: number): string {
  return total <= 1
    ? `${ITEM_EPISODE_PREFIX}${itemId}`
    : `${ITEM_EPISODE_PREFIX}${itemId}#${index}`;
}

/**
 * Parse an episode name back to its brain item id, tolerating the optional `#<chunk>` suffix.
 * Returns undefined for non-item episodes (e.g. `correction:<arc_id>` writeback episodes), so callers
 * can link a fact/event to the ONE item behind it regardless of how many chunks it was split into.
 */
export function itemIdFromEpisodeName(name: string | null | undefined): string | undefined {
  if (!name || !name.startsWith(ITEM_EPISODE_PREFIX)) return undefined;
  const rest = name.slice(ITEM_EPISODE_PREFIX.length);
  const hash = rest.indexOf("#");
  return hash === -1 ? rest : rest.slice(0, hash);
}
