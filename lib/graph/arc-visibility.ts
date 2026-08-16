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
 *
 * RESIDUAL (documented, deferred to Phase C — the operator flipping `enforcing` must know): this
 * filters on the CITED-evidence item ids, but an arc's title/summary (and its LLM-name participant
 * fallback, `arc-attribution.groundParticipants`) were SYNTHESIZED from the full tier fact pool,
 * which includes facts from items the member can't see. A kept arc's PROSE can therefore still name
 * restricted work that wasn't among its cited evidence. The background evidence-coherence prune
 * (`arcs.applyCoherencePrune`) can even remove a restricted citation AFTER the prose was written,
 * laundering the marker this filter keys on. The structural fix is per-project synthesis (Phase C);
 * this read-time filter is a substantial Phase-B reduction (an arc whose cited basis is restricted
 * is dropped), not a complete guarantee that a served arc's text mentions nothing restricted.
 */
export function filterArcsByVisibleItems(
  arcs: NarrativeArc[],
  visibleItemIds: ReadonlySet<string> | null
): NarrativeArc[] {
  if (visibleItemIds == null) return arcs; // permissive — no enforcement
  return arcs.filter((arc) => {
    if (arc.evidence.length === 0) return false; // no evidence → no verifiable basis → fail closed
    // EVERY evidence ENTRY must resolve to a VISIBLE item. An entry with no `itemId` (episode
    // resolution missed — a partial miss is `ok:true` and never sets `degraded`, so it's a normal
    // shape, not an error) still carries raw `fact` text with no verifiable partition, so it fails
    // closed too. Filtering the undefined entries out BEFORE the `every` let a mixed arc
    // `[{itemId: visible}, {itemId: undefined, fact: "<restricted>"}]` survive and serve the
    // restricted fact text (Fable B5 High).
    return arc.evidence.every((e) => e.itemId != null && visibleItemIds.has(e.itemId));
  });
}
