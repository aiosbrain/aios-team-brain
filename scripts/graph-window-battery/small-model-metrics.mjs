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
    // A summary with NOTHING left after its own name is stripped is pure name-repetition: it says
    // nothing about the entity. Review measured this scoring {distinctness:1, factOverlap:1} —
    // PERFECT on every term — because an empty word set matched no previous summary and the name
    // itself appears in the entity's facts. Count it as a duplicate: it is the degenerate case of
    // boilerplate, not a distinct summary.
    if (w.size === 0) {
      duplicates += 1;
      continue;
    }
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
  // ZERO dated edges is UNDEFINED, not 0.0 (AC5). The metric is only meaningful as a ratio to the
  // incumbent, and an incumbent of 0 makes that ratio Infinity/NaN — a number no band can read. "No
  // datable edges in this corpus" is an absence of evidence, and must not be reported as total
  // coverage collapse.
  if (dated === 0) return { total, share: null };
  return { total, share: dated / total };
}

/**
 * Is a metric capable of MOVING on this corpus, or is it pinned at a structural extreme?
 *
 * WHY THIS EXISTS — it is Q3's lesson, mechanised. Q3 (IS_DUPLICATE_OF share) read a structural ZERO
 * on every arm because graphiti 0.29.3 stopped writing the relation, and that was only discovered
 * LIVE, mid-session, after the money was spent (`decision.mjs` Amendment 2). Q11 has the same shape of
 * risk from the other end: `lib/graph/extraction-health.ts:348` records that graphiti BACKDATES
 * `valid_at` to the episode's work time, so coverage may be ~1.0 on every arm — a metric that cannot
 * fall, quietly scoring a meaningless ratio of 1.0 as PASS. It could not be settled empirically before
 * building: NEO4J_URI is an internal Railway address with no public proxy.
 *
 * So the metric proves informativeness on the corpus it is ACTUALLY run against, instead of a human
 * asserting it once. `bandMargin` makes "room to move" concrete: room to move *by the amount the band
 * would need to see*. A ceiling metric (coverage 0.99 against a 15% band) cannot fall 15% without
 * going below what the data can express; a floor metric cannot fall at all.
 *
 * UNINFORMATIVE IS NOT PASS. A metric that cannot fail is not evidence of safety — counting it as a
 * pass is how a battery ships an arm on a gate that was never armed. The caller must exclude it from
 * gating AND report it, so the readout says which questions this corpus could not answer.
 */
export function assessInformativeness(incumbentReps, { bandMargin, floor = 0, ceiling = 1 } = {}) {
  if (!Array.isArray(incumbentReps) || incumbentReps.length === 0) {
    return { informative: false, reason: "no incumbent reps" };
  }
  const usable = incumbentReps.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (usable.length === 0) {
    // `null` is what the scorers return for "no evidence" — an absence, not a zero.
    return { informative: false, reason: "incumbent produced no measurable value (null/NaN)" };
  }
  const mean = usable.reduce((a, b) => a + b, 0) / usable.length;
  if (typeof bandMargin !== "number" || !(bandMargin > 0)) {
    return { informative: false, reason: "no band margin supplied — cannot judge room to move" };
  }
  // Room to FALL by the band's own margin, expressed in the metric's units.
  const roomBelow = mean - mean * (1 - bandMargin);
  if (mean - roomBelow < floor - 1e-9) {
    return { informative: false, reason: `incumbent mean ${mean.toFixed(4)} cannot fall by the band without passing the floor ${floor}` };
  }
  // A metric already AT the ceiling has nowhere to rise, which matters for two-sided bands, and a
  // metric at the floor has nowhere to fall — both make the gate unarmable in the direction that counts.
  if (mean >= ceiling - 1e-9) {
    return { informative: false, reason: `incumbent mean ${mean.toFixed(4)} sits at the structural ceiling ${ceiling} — no room to move` };
  }
  if (mean <= floor + 1e-9) {
    return { informative: false, reason: `incumbent mean ${mean.toFixed(4)} sits at the structural floor ${floor} — no room to move` };
  }
  return { informative: true, mean };
}
