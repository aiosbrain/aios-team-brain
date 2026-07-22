/**
 * Episode naming for the brain→Graphiti projection, shared by the projector, the reconcile pass, and
 * the Learning reads so every seam agrees on the format. Pure — no server-only deps.
 *
 * A large item is projected as SEVERAL episodes (chunks) so each stays small enough for Graphiti's
 * extractor (its output is hard-capped — an oversized episode overflows it and never becomes facts).
 * To stay backward-compatible, a single-chunk item keeps the plain `items:<id>` name; only a
 * multi-chunk item gets a `#<k>` suffix: `items:<id>#0`, `items:<id>#1`, …
 */

/** The episode name for chunk `index` of `total` chunks of item `itemId`. */
export function episodeName(itemId: string, index: number, total: number): string {
  return total <= 1 ? `items:${itemId}` : `items:${itemId}#${index}`;
}

/**
 * Parse an episode name back to its brain item id, tolerating the optional `#<chunk>` suffix.
 * Returns undefined for non-item episodes (e.g. `correction:<arc_id>` writeback episodes), so callers
 * can link a fact/event to the ONE item behind it regardless of how many chunks it was split into.
 */
export function itemIdFromEpisodeName(name: string | null | undefined): string | undefined {
  if (!name || !name.startsWith("items:")) return undefined;
  const rest = name.slice("items:".length);
  const hash = rest.indexOf("#");
  return hash === -1 ? rest : rest.slice(0, hash);
}
