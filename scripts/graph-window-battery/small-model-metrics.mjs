/**
 * Q10 (summary health) and Q11 (temporal coverage) — the two quality gaps the SMALL-model arm opens
 * that the existing battery cannot see (GRAPHSMALL-1).
 *
 * WHY THESE TWO EXIST. The arm downgrades exactly the calls upstream marks `ModelSize.small`:
 * `dedupe_edges`, `node_summaries_batch`, `edge_timestamps`. The battery already covers the first
 * (Q7 convergence + Q1's upper bound). The other two govern **entity summary text** and **fact
 * temporal bounds**, and NOTHING in the existing metric set reads either — so shipping without these
 * would have tested the one downgraded kind that already had coverage and waved through the two that
 * did not.
 *
 * NUMBERED Q10/Q11, NOT Q8/Q9: `q8-orphan-drop.mjs` already defines `Q8′` for PIPEFF-5. Two meanings
 * on one label inside one battery is a reporting bug waiting to happen.
 *
 * PURE, and separate from the Neo4j reads in `measure.ts`, so every branch below is unit-testable
 * against hand-built rows — including the adversarial shapes (uniform boilerplate, a padding model)
 * that are the whole reason the naive version of Q10 was rejected in review.
 */

/** Case/whitespace-normalised, so trivial formatting differences are not counted as distinctness. */
const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Word set of a string, for overlap scoring. Short tokens carry no signal and are dropped. */
function words(s) {
  return new Set(
    norm(s)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3)
  );
}

/** |A ∩ B| / |A| — how much of the summary's substance is drawn from the entity's own facts. */
function overlapShare(summary, facts) {
  const a = words(summary);
  if (a.size === 0) return 0;
  const b = words(facts.join(" "));
  let hit = 0;
  for (const w of a) if (b.has(w)) hit += 1;
  return hit / a.size;
}

/**
 * Q10 — summary health over `(:Entity)` rows of `{ name, summary, facts[] }`.
 *
 * THREE terms, because review proved one is not enough. Non-empty share and mean length catch a
 * blank/truncating/padding model, but **pass same-length boilerplate**: an arm that writes "This
 * entity is mentioned in the source material." for every entity at incumbent-like length scores
 * identically to a good one on both. So:
 *
 *   nonEmptyShare  — the floor: did it write anything at all
 *   meanLength     — two-sided against the incumbent: truncation AND padding
 *   distinctness   — share of summaries that are NOT near-duplicates of another summary. Boilerplate
 *                    is by construction self-similar, so this is what makes it visible.
 *   factOverlap    — mean share of summary words that appear in that entity's own facts. Boilerplate
 *                    is also DETACHED from the entity: it can be distinct-ish (name interpolated) and
 *                    still say nothing the facts support.
 *
 * Distinctness and factOverlap are independent detectors on purpose — a model can defeat either one
 * alone (vary the filler to beat distinctness; quote a fact verbatim to beat overlap) but doing both
 * is writing a real summary, which is the outcome we want anyway.
 */
export function scoreSummaryHealth(rows) {
  const total = rows.length;
  if (total === 0) {
    // No entities is not "healthy summaries" — it is no evidence. Refuse rather than return 1.
    return { total: 0, nonEmptyShare: null, meanLength: null, distinctness: null, factOverlap: null };
  }
  const nonEmpty = rows.filter((r) => norm(r.summary).length > 0);
  const nonEmptyShare = nonEmpty.length / total;
  if (nonEmpty.length === 0) {
    return { total, nonEmptyShare: 0, meanLength: 0, distinctness: 0, factOverlap: 0 };
  }
  const meanLength = nonEmpty.reduce((n, r) => n + norm(r.summary).length, 0) / nonEmpty.length;

  // Distinctness: a summary is a near-duplicate if its normalised text equals another's, or its word
  // set overlaps another's by ≥ 0.9 in BOTH directions.
  //
  // THE ENTITY'S OWN NAME IS REMOVED FIRST, and that is what makes this work. Boilerplate in practice
  // is one template with the name interpolated — "Chetan is an entity mentioned in the source
  // material" / "Graphiti is an entity mentioned in the source material". With the name left in,
  // those overlap 6/7 = 0.857 and slip under any threshold loose enough not to flag genuinely similar
  // real summaries (a test caught exactly this). Stripping the name compares the TEMPLATE, so
  // name-only variation reads as the duplicate it is, without lowering the bar for real text.
  const seen = [];
  let duplicates = 0;
  for (const r of nonEmpty) {
    const own = words(r.name);
    const w = new Set([...words(r.summary)].filter((x) => !own.has(x)));
    const dup = seen.some((prev) => {
      if (prev.text === norm(r.summary)) return true;
      if (w.size === 0 || prev.w.size === 0) return false;
      let hit = 0;
      for (const x of w) if (prev.w.has(x)) hit += 1;
      return hit / w.size >= 0.9 && hit / prev.w.size >= 0.9;
    });
    if (dup) duplicates += 1;
    else seen.push({ text: norm(r.summary), w });
  }
  const distinctness = (nonEmpty.length - duplicates) / nonEmpty.length;

  const factOverlap =
    nonEmpty.reduce((n, r) => n + overlapShare(r.summary, r.facts ?? []), 0) / nonEmpty.length;

  return { total, nonEmptyShare, meanLength, distinctness, factOverlap };
}

/**
 * Q11 — temporal coverage: the share of `RELATES_TO` edges carrying a resolved `valid_at`.
 *
 * Meaningful ONLY as a ratio to the incumbent arm, because the extractor sets many dates itself and
 * `edge_timestamps` fires only for the ones it left unset — so the absolute level says more about the
 * corpus than about the model. `null` (not 0) when there are no edges at all: "no evidence" and
 * "no coverage" are different answers, and returning 0 would let an empty run read as a total
 * regression.
 */
export function scoreTemporalCoverage(edges) {
  const total = edges.length;
  if (total === 0) return { total: 0, share: null };
  const dated = edges.filter((e) => {
    const v = e?.valid_at;
    if (v === null || v === undefined) return false;
    return String(v).trim().length > 0;
  }).length;
  return { total, share: dated / total };
}
