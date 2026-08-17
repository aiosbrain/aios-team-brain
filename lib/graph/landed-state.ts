import { episodeName } from "./episode-name";

/**
 * How much of a projected item actually landed in the graph (RECONCILE-1, increment 1).
 *
 * WHY THIS IS ONLY MEASURED, NOT ENFORCED. `lib/graph/reconcile.ts` treats an item as landed if ANY of
 * its chunks is present, so a worker that dies mid-item leaves the tail chunks absent forever — the
 * ledger already records every chunk sha at push, so the delta path skips them too. Observed live in
 * the PIPEFF-2 battery: a 502 killed the worker at chunk #33 of `docs/ARCHITECTURE.md`, and reconcile
 * requeued 0 for it while correctly requeuing 7 fully-missing items.
 *
 * The obvious fix — re-queue on `partial` — is NOT applied yet, and the reason is in
 * `docs/design/reconcile-partial-chunks.md`: a cold read found three ways it makes things WORSE.
 *   1. Expected names are not derivable after an edit. The delta path pushes by SHA (set membership,
 *      position-independent) but names by INDEX, so inserting a chunk mid-document leaves the graph
 *      holding old `#0..#2` plus a new `#1` while the ledger holds 4 shas — expected `#3` never
 *      existed, and a strict check would re-queue a perfectly healthy item on an ordinary edit.
 *   2. It re-opens the amplifier `LANDED_GRACE_MS` exists to close: episodes appear only as Graphiti's
 *      queue drains, so "all N visible" is a far harder bar than "any one visible", and a big item
 *      behind a backlog reads partial → gets re-pushed in full → deepens the backlog.
 *   3. A re-queue re-pushes ALL chunks and `addEpisodes` does not overwrite by name, so every heal
 *      adds ~N-1 duplicate episodes, growing the group toward `LANDED_SCAN_DEPTH`, past which
 *      self-healing switches off for it permanently.
 *
 * So this module answers "how often is an item actually partial in prod?" — the number that tells us
 * whether increment 2 is worth building at all, and which separates a real hole from those two
 * false-positive channels. Pure, so every branch is unit-testable without a graph.
 */

/** `"none"` is also what a never-pushed row reports — see `landedState`. */
export type LandedState = "full" | "partial" | "none";

/**
 * Every episode name a fully-landed item of `chunkCount` chunks should have.
 *
 * Delegates to `episodeName` rather than restating the convention, because the single-chunk form has
 * no `#k` suffix (`items:<id>`) and duplicating that rule is how the two drift apart.
 */
export function expectedEpisodeNames(itemId: string, chunkCount: number): string[] {
  const total = Math.max(1, Math.floor(chunkCount || 0));
  return Array.from({ length: total }, (_, i) => episodeName(itemId, i, total));
}

/**
 * Compare a row's expected episode names against the names actually present in the group's scan.
 *
 * An EMPTY chunk ledger returns `"none"`, which preserves the discriminator reconcile already depends
 * on: *"A row that EVER pushed keeps its chunk_shas (the re-queue resets only the sha), so the empty
 * ledger is the honest discriminator."* A never-pushed row is the PROJECTOR's to converge, and must
 * not be mistaken here for an item whose chunks vanished.
 */
export function landedState(
  itemId: string,
  chunkCount: number,
  presentNames: ReadonlySet<string>
): { state: LandedState; missing: string[] } {
  // No ledger ⇒ nothing was ever claimed in Graphiti ⇒ "never landed" is vacuous, not partial.
  if (!chunkCount || chunkCount <= 0) {
    return { state: "none", missing: [] };
  }
  const expected = expectedEpisodeNames(itemId, chunkCount);
  const missing = expected.filter((n) => !presentNames.has(n));
  if (missing.length === 0) return { state: "full", missing: [] };
  if (missing.length === expected.length) return { state: "none", missing };
  return { state: "partial", missing };
}

/**
 * How many partial items to describe in the durable record. BOUNDED because this lands in
 * `ingest_runs.meta`, which is read on a dashboard: a pathological pass must not write an unbounded
 * blob into a row nobody can then load.
 */
export const PARTIAL_DETAIL_LIMIT = 5;

/** Trim the per-item detail to something a meta blob can carry, and say what was elided. */
export function boundPartialDetail(
  items: { itemId: string; missing: string[] }[],
  limit: number = PARTIAL_DETAIL_LIMIT
): { sample: { itemId: string; missing: string[]; missingCount: number }[]; elided: number; namesElided: number } {
  let namesElided = 0;
  const sample = items.slice(0, limit).map((d) => {
    // A 40-chunk item missing 39 names would itself be a blob; the count is the signal, the first few
    // names are the diagnosis.
    const missing = d.missing.slice(0, limit);
    namesElided += Math.max(0, d.missing.length - missing.length);
    return { itemId: d.itemId, missing, missingCount: d.missing.length };
  });
  // `missingCount` per item + `namesElided` overall, because review found within-item truncation was
  // INVISIBLE: an item missing 40 names showed 5 with `elided: 0`, indistinguishable from an item
  // missing exactly 5 — and "how deep is the hole" is a different question from "how many items".
  return { sample, elided: Math.max(0, items.length - sample.length), namesElided };
}
