#!/usr/bin/env node
/**
 * PRE-FLIGHT: which graph call kinds actually carry Graphiti's small-model marker? (GRAPHSMALL-1)
 *
 * WHY THIS RUNS BEFORE ANYTHING IS SPENT. `SMALL_ELIGIBLE_KINDS` lists `node_summaries_batch` and
 * `edge_timestamps` on the strength of a CODE COMMENT ("0.29.3 marks these ModelSize.small too"), not
 * on anything observed. It cannot be settled from `llm_usage`: the marker lives in the REQUEST body,
 * `smallTarget` is null in prod today so everything routes strong regardless, and we store the model
 * that ANSWERED, not the one that was asked for.
 *
 * The stake is not academic. `node_summaries_batch` is 10.0% of graph spend. If the deployed image
 * does not mark it small, the addressable prize is **18.7%, not 28.7%** — which is exactly the input
 * `smallModelMetrics({ addressableShare })` uses to set the C2 cost band. Getting it wrong sets the
 * ship threshold against a ceiling that does not exist.
 *
 * The capture tap already writes every request body to JSONL, so this is a free, empirical answer:
 * replay a projection with the tap on (the RUNBOOK steps BEFORE the paid step) and point this at the
 * capture file.
 *
 * Usage:
 *   node scripts/graph-window-battery/small-marker-preflight.mjs /tmp/gwb/capture-*.jsonl
 *
 * Output: one JSON object — per-kind marker counts, the eligible set it implies, and the addressable
 * share to feed the decision function.
 */
import { readFileSync } from "node:fs";
import { classifyGraphCall, SMALL_ELIGIBLE_KINDS, isSmallModelSignal } from "../../lib/llm/graph-call-kind.ts";

/**
 * Tally marker presence per call kind over tap records.
 *
 * PURE and exported so the counting is unit-testable without a capture file. Only `kind:"request"`
 * records carry a request body; a response record has no `model` field to read and must not be
 * counted as "unmarked", which would silently halve every share.
 */
export function tallyMarkers(records) {
  const byKind = new Map();
  let requests = 0;
  for (const rec of records) {
    if (!rec || rec.kind !== "request" || !rec.body) continue;
    requests += 1;
    const kind = classifyGraphCall(rec.body);
    const marked = isSmallModelSignal(rec.body.model);
    const cur = byKind.get(kind) ?? { kind, calls: 0, marked: 0 };
    cur.calls += 1;
    if (marked) cur.marked += 1;
    byKind.set(kind, cur);
  }
  const kinds = [...byKind.values()].sort((a, b) => b.calls - a.calls);
  return { requests, kinds };
}

/**
 * What the observed markers imply for the battery.
 *
 * `observedEligible` is the set the DEPLOYED image actually asks to downgrade. `unexpected` and
 * `missing` are the two ways the code's table can be wrong, and BOTH matter:
 *   - `missing`  — a kind the table claims is eligible but which never carried the marker. This is
 *                  the 28.7% → 18.7% case; it shrinks the prize.
 *   - `unexpected` — a kind that carried the marker but is NOT in `SMALL_ELIGIBLE_KINDS`. The proxy
 *                  would keep routing it strong, so it is unclaimed savings, not a risk — but it
 *                  means the table has drifted from the image and should be re-derived.
 */
/**
 * Kinds that exist only in graphiti 0.13.2. The deployed image is 0.29.3, where the per-entity
 * `node_attributes` fan-out was REPLACED by batched `node_summaries_batch` — so its absence from a
 * healthy capture is expected, not drift. Reporting it as `missing` would raise a false alarm on
 * every correct run, and an alarm that always fires is one nobody reads.
 */
const LEGACY_KINDS = new Set(["node_attributes"]);

/**
 * `costByKind` MUST be shares of TOTAL graph spend, summing to ~1 across ALL kinds — not a subset.
 *
 * This contract is load-bearing and was previously only implied: `addressableShare` feeds
 * `smallModelMetrics`, whose band flips at 0.2, and those thresholds (0.287 / 0.187) are shares of
 * the WHOLE graph bill. Pass two kinds totalling 0.273 and the function returns 0.634 — a number that
 * selects the 15% band when the true addressable share is 17.3% and the spec demands 10%. Review
 * caught this precisely because a test of mine pinned that wrong usage as if it were correct.
 */
export function assessEligibility(tally, costByKind = {}) {
  const observedEligible = tally.kinds.filter((k) => k.marked > 0).map((k) => k.kind);
  const declared = [...SMALL_ELIGIBLE_KINDS];
  const missing = declared.filter((k) => !observedEligible.includes(k) && !LEGACY_KINDS.has(k));
  const unexpected = observedEligible.filter((k) => !SMALL_ELIGIBLE_KINDS.has(k));

  // Addressable share = the cost share of kinds that are BOTH declared eligible (so the proxy will
  // route them) AND observed carrying the marker (so graphiti will ask). Either alone routes strong.
  const total = Object.values(costByKind).reduce((n, v) => n + v, 0);
  const routable = observedEligible.filter((k) => SMALL_ELIGIBLE_KINDS.has(k));
  const addressable = routable.reduce((n, k) => n + (costByKind[k] ?? 0), 0);

  // REFUSE, don't just report (AC10). A capture where nothing routable carries the marker means the
  // battery can save 0% — running it would spend money to measure a lever that is not connected.
  // Emitting JSON and exiting 0 let that read as a normal pre-flight.
  const refusal =
    routable.length === 0
      ? "no routable kind carries the small-model marker — the lever cannot save anything on this image; re-derive SMALL_ELIGIBLE_KINDS before running the battery"
      : null;

  return {
    observedEligible,
    routable,
    missing,
    unexpected,
    refusal,
    // Shares of TOTAL graph spend — see the contract above. `null` when no cost map was supplied,
    // so a caller cannot mistake "unknown" for "zero addressable".
    addressableShare: total > 0 ? addressable / total : null,
  };
}

function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: small-marker-preflight.mjs <capture.jsonl> [more.jsonl ...]");
    process.exit(1);
  }
  const records = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A truncated final line is normal on an interrupted run; a malformed body is not our problem
        // to fix here. Skipping is safe because `requests` reports what WAS counted.
      }
    }
  }
  const tally = tallyMarkers(records);
  // Measured 2026-08-05..08-16 (the clean post-instrumentation window); see the spec.
  const COST_SHARE = {
    dedupe_nodes: 0.251,
    extract_edges: 0.242,
    extract_nodes: 0.219,
    dedupe_edges: 0.173,
    node_summaries_batch: 0.1,
    edge_timestamps: 0.014,
  };
  const assessment = assessEligibility(tally, COST_SHARE);
  console.log(JSON.stringify({ ...tally, ...assessment }, null, 2));
  if (assessment.refusal) {
    console.error(`REFUSING: ${assessment.refusal}`);
    process.exit(2);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
