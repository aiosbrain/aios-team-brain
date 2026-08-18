/**
 * Is a staleness threshold MIS-FITTED to the leg it judges? (BANNERFLAP-2,
 * `docs/design/staleness-threshold-fit.md`.)
 *
 * WHY THIS EXISTS. `STALE_MS_BY_SOURCE` in `lib/ingest/pipeline-health` encodes a rule — "each
 * infrequent/irregular leg gets its OWN threshold = its cadence + grace" — that has been applied by
 * hand, after the fact, SIX times: `auth_cleanup`, `doc_task_infer`, `arcs` and `dense` were each
 * re-tuned or nulled once a human happened to notice the loud banner naming a healthy job, and
 * `meeting_notes` / `context_backfill[_all]` are instances five and six. Every recurrence was
 * detectable from data the system already had. This turns "someone eventually notices a flapping
 * banner" into a number.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: derive a replacement threshold. Auto-fitting each bar to the
 * leg's own observed cadence was considered and REJECTED in the spec, because it fails in the
 * dangerous direction — a leg degrading gradually raises its own bar and goes SILENT. Crying wolf is
 * annoying; a health banner that quietly stops alarming is the failure the whole threshold map exists
 * to prevent. So a finding carries the observed numbers and nothing else: widening a bar stays a
 * human editing a constant with the measurement in front of them. (Not even a `suggestedMs` field —
 * a suggestion that is always right is an auto-fit with an extra step.)
 *
 * CONSUMER TODAY: `test/pipeline-threshold-misfit.test.ts`, which runs it over the recorded prod
 * cadences and asserts the SHIPPED thresholds are all clear — so narrowing one below a measured gap
 * reddens the suite. Wiring it to an admin surface is deferred until a 7th recurrence justifies the
 * surface (spec §Scope); this module is pure and importable from anywhere when that day comes.
 */

/** One leg's observed run cadence, as measured from `ingest_runs` (`trigger='scheduler'` rows only —
 *  the same filter the staleness clock uses; an on-demand run is not evidence the poller is alive). */
export interface ObservedCadence {
  /** Longest gap between consecutive scheduler runs, in ms. */
  worstGapMs: number;
  /** 95th-percentile gap, in ms. Always <= `worstGapMs`; it separates "over the bar routinely" from
   *  "one tail excursion", which is the difference between a wrong threshold and a slow week. */
  p95GapMs: number;
  /** Scheduler runs the gaps were derived from. Fewer than 2 yields no gap at all. */
  runs: number;
}

export interface ThresholdMisfit {
  source: string;
  thresholdMs: number;
  worstGapMs: number;
  p95GapMs: number;
  runs: number;
  /** The p95 gap ALSO clears the bar — the leg is over its threshold routinely, not once. */
  chronic: boolean;
}

/**
 * Every leg whose observed gap reaches or exceeds its configured staleness threshold — i.e. every leg
 * the banner will call "broken" while it is merely running at its normal pace.
 *
 * `thresholdFor` is passed in rather than imported so this stays pure (`pipeline-health` is
 * `server-only`) and so a caller can ask the question of a HYPOTHETICAL threshold map — which is how
 * the fix is demonstrated against the pre-change constants rather than merely asserted.
 *
 * A `null` threshold is never reported: a leg that is never aged cannot be mis-fitted. A leg with
 * fewer than two runs is never reported either, and that floor is STRUCTURAL, not a policy — one run
 * yields zero gaps, so there is nothing to compare. No sample-size floor beyond that: a "needs N runs
 * before we'll say anything" knob would fail in the silent direction this module refuses to fail in.
 */
export function detectMisfitThresholds(
  cadenceBySource: Readonly<Record<string, ObservedCadence>>,
  thresholdFor: (source: string) => number | null
): ThresholdMisfit[] {
  const misfits: ThresholdMisfit[] = [];
  for (const [source, cadence] of Object.entries(cadenceBySource)) {
    const thresholdMs = thresholdFor(source);
    if (thresholdMs === null) continue; // never aged → nothing to mis-fit
    // A non-finite threshold slips past BOTH the null check and the `<` comparison below, because
    // every comparison with NaN is false — it would emit a finding whose numbers are NaN and whose
    // sort key poisons the comparator. Unreachable through `staleThresholdMs` (literal constants
    // only), and closed here rather than trusted, since the map is exactly the thing this module
    // exists to be suspicious of.
    if (!Number.isFinite(thresholdMs)) continue;
    if (!Number.isFinite(cadence.runs) || cadence.runs < 2) continue; // no gap observable from <2 runs
    if (!Number.isFinite(cadence.worstGapMs)) continue;
    // `>=`, not `>`: the banner fires at `now - clock > threshold`, and a gap that lands exactly ON
    // the bar means the leg is already spending time indistinguishable from broken. Reporting it is
    // the point — this is a diagnostic, not the alarm itself.
    if (cadence.worstGapMs < thresholdMs) continue;
    misfits.push({
      source,
      thresholdMs,
      worstGapMs: cadence.worstGapMs,
      p95GapMs: cadence.p95GapMs,
      runs: cadence.runs,
      chronic: Number.isFinite(cadence.p95GapMs) && cadence.p95GapMs >= thresholdMs,
    });
  }
  // Worst overshoot first, then by name — a stable order, and deliberately an ABSOLUTE excess rather
  // than a ratio, which would divide by a zero threshold.
  return misfits.sort(
    (a, b) => b.worstGapMs - b.thresholdMs - (a.worstGapMs - a.thresholdMs) || a.source.localeCompare(b.source)
  );
}
