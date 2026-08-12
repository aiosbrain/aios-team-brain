import type { NarrativeArc } from "./arcs";

/**
 * Access enforcement for narrative arcs (Phase B slice 5, spec §5.8/§5.8b/§17-B).
 *
 * An arc is an LLM-SYNTHESIZED narrative over its cited evidence — you cannot partially redact a
 * synthesized title/summary, so the gate is all-or-nothing: keep an arc only when EVERY cited
 * evidence item is visible to the principal. If even one is invisible the narrative may describe
 * that restricted work, so the whole arc drops.
 *
 * An arc with NO linkable `itemId` evidence has no verifiable item basis — its narrative rests
 * purely on the graph, which stays unpartitioned until Phase C (§5.8b). It therefore fails CLOSED
 * (dropped) under enforcement rather than being served on trust.
 *
 * This is a READ-TIME filter over the tier-scoped `arc_cache` — no re-synthesis, no per-principal
 * cache variant (arc synthesis is LLM-expensive and the spec plans `arc_cache` to go per-project in
 * Phase C, not per-hash in B). `null` visibleItemIds = permissive team → passthrough, byte-identical.
 */
export function filterArcsByVisibleItems(
  arcs: NarrativeArc[],
  visibleItemIds: ReadonlySet<string> | null
): NarrativeArc[] {
  if (visibleItemIds == null) return arcs; // permissive — no enforcement
  return arcs.filter((arc) => {
    const itemIds = arc.evidence.map((e) => e.itemId).filter((id): id is string => !!id);
    if (itemIds.length === 0) return false; // no verifiable item basis → fail closed
    return itemIds.every((id) => visibleItemIds.has(id)); // ALL cited evidence must be visible
  });
}
