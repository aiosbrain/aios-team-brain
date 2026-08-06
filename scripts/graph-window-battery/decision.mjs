/**
 * The battery's decision procedure, as code (PIPEFF-2 / AIO-821).
 *
 * WHY THIS IS CODE AND NOT PROSE. The failure this whole workstream exists to prevent is a readout
 * that gets *interpreted* after the numbers exist. It already happened once: on EXMODEL-1 a synthetic
 * fixture was iterated twice, and a third iteration would have been tuning it until it agreed with
 * the conclusion. The fixture was the visible joint. The invisible one is analysis flexibility — a
 * band, a noise rule and a kill rule that do not compose into a total function, so the metric that
 * lands in the gap gets read whichever way suits.
 *
 * So the rules from `docs/design/graph-episode-window.md` live here, executable and unit-pinned,
 * and the runner calls this rather than a human reading a table. Changing a band means editing a
 * constant that a test asserts, in a commit, before the run — which is the whole point.
 *
 * ── THE PROCEDURE ────────────────────────────────────────────────────────────────────────────────
 *
 * Each arm runs TWICE on the same corpus into a fresh database. An arm's value for a metric is the
 * MEAN of its two reps; the incumbent's own |rep1 - rep2| is the noise estimate (`spread`).
 *
 * Per metric, exactly one of — and the rule is SYMMETRIC about the band:
 *   PASS         the arm beats the band by MORE than the incumbent's spread
 *   FAIL         the arm misses the band by MORE than the incumbent's spread
 *   INCONCLUSIVE the arm lands WITHIN ±spread of the band
 *
 * INCONCLUSIVE counts as FAIL for shipping. The burden of proof is on the change: a metric we cannot
 * distinguish from a regression is not evidence there is none.
 *
 * WHY THE PASS SIDE CARRIES THE SPREAD TOO. An earlier draft required only "the mean meets the band",
 * which made the noise estimate irrelevant to every above-band outcome — while the bands are
 * MULTIPLICATIVE in the incumbent's mean. A degraded incumbent rep therefore LOWERED the bar: true
 * W10 yield 10.0, reps 10.2 and 6.0, mean 8.1, band 7.29, and an arm whose true value is 8.5 (a real
 * 15% regression) passes. More noise, easier shipping. Symmetric, that arm fails.
 *
 * ── SESSION VALIDITY ─────────────────────────────────────────────────────────────────────────────
 *
 * The ceiling on the incumbent's spread is expressed in BAND UNITS, not as a fraction of the mean.
 * "Spread > 25% of the mean" was degenerate in both directions: Q5's healthy mean is ~0, so a single
 * validation retry in one incumbent rep would invalidate every session; and at a healthy 30% dupe
 * share it permitted a 7.5pp spread against a ±5pp band, making Q3's PASS window EMPTY — a session
 * valid by the rules with a metric no arm could ever pass. A procedure that can deadlock mid
 * experiment is one that gets rewritten under pressure.
 *
 * So: the incumbent's spread must be at most HALF that metric's band margin. That also GUARANTEES a
 * non-empty PASS window in any valid session, which is the property the old ceiling lacked.
 */

/**
 * The gated metrics. `margin` is the distance from the incumbent's own value to the band edge, in
 * the band's units; `maxSpread` is half of it (the validity ceiling), except where a near-zero
 * healthy mean needs an absolute floor.
 *
 * `kind`:
 *   ratio-lower   the arm's value ÷ incumbent's must be at least `1 - margin`
 *   ratio-both    …and at most `1 + margin` (an INCREASE is disqualifying too)
 *   ratio-upper   the arm's value ÷ incumbent's must be at most `1 + margin`
 *   pp-both       |arm - incumbent| in percentage points must stay within `margin`
 *   pp-upper      arm - incumbent in percentage points must stay at or below `margin`
 *   ratio-fall    the arm's value must be at most `1 - margin` of the incumbent's (a REQUIRED fall)
 */
export const METRICS = Object.freeze({
  // Two-sided: fragmentation RAISES node count, and a one-sided floor waved that through. It is also
  // the catch-all for the variant-form inflation Q6 cannot see — a node named "John" carries no
  // member name, so it never enters Q6's denominator, but it does inflate this.
  Q1: { label: "entity yield / episode", kind: "ratio-both", margin: 0.1, maxSpreadRatio: 0.05 },
  // TWO clauses, both floors, and the stricter binds. The ratio is the noisy one; `absolute` is the
  // one that bites at small n, which is exactly where the ratio is weakest — at 12 names, "95%"
  // rounds to "lose none", so without this clause a 2-person loss on a thin corpus would ship.
  //
  // The count clause is deliberately NOISE-FREE: no tolerance, no INCONCLUSIVE. A spread on an
  // integer count of people would swallow the clause whole (any spread ≥ 1 makes "lost 2" and "lost
  // 0" indistinguishable), which would delete the floor it exists to be. Losing two known people
  // outright is not a statistical question.
  Q2: {
    label: "people recall",
    kind: "ratio-lower",
    margin: 0.05,
    maxSpreadRatio: 0.025,
    absolute: { input: "personsLost", max: 1, describe: (v) => `${v} people lost outright (max 1)` },
  },
  // Two-sided in PERCENTAGE POINTS: a failure-to-merge emits no IS_DUPLICATE_OF edge at all, so
  // fragmentation makes this share FALL. extraction-health.ts already treats an anomalously low
  // share as evidence the predicate is broken rather than the graph clean.
  Q3: { label: "IS_DUPLICATE_OF share", kind: "pp-both", margin: 0.05, maxSpreadPp: 0.025 },
  Q4: { label: "cross-chunk continuity", kind: "ratio-lower", margin: 0.15, maxSpreadRatio: 0.075 },
  // 3pp, not 2: at ~100 episodes one retry ≈ 1pp, so a 1.5pp ceiling tolerates exactly one retry of
  // rep-to-rep difference and not two. The widening does not cost the guard its teeth — a retry adds
  // ~8,400 input tokens against a ~40,000/attempt baseline, so the full 3-retry allowance is a -2.3%
  // artifact on C1, against a band demanding -25%.
  Q5: { label: "signed retry gap", kind: "pp-upper", margin: 0.03, maxSpreadPp: 0.015 },
  Q6: { label: "cross-item entity convergence", kind: "ratio-upper", margin: 0.05, maxSpreadRatio: 0.025 },
  // The lever must EARN its deploy: this service's redeploy history is not free (see the spec's
  // Rollout). A quality-clean arm that barely moves tokens does not ship.
  C1: { label: "input tokens / episode", kind: "ratio-fall", margin: 0.25, maxSpreadRatio: 0.125 },
});

export const VERDICT = Object.freeze({ PASS: "PASS", FAIL: "FAIL", INCONCLUSIVE: "INCONCLUSIVE" });

const mean = (a, b) => (a + b) / 2;
const spread = (a, b) => Math.abs(a - b);

/**
 * "Strictly over the ceiling", tolerant of float representation.
 *
 * The spec says the incumbent's spread must be **at most** half the band margin, so a spread sitting
 * exactly on the ceiling is VALID. Written as a bare `>` that fails: `0.3125 - 0.2875` evaluates to
 * 0.025000000000000022, which is "over" a 0.025 ceiling by 2e-17 and invalidates a session on
 * nothing. The relative epsilon is ~1e-9 — twelve orders of magnitude below any measurement this
 * battery takes, so it can only ever absorb representation error, never a real breach.
 */
const over = (value, ceiling) => value > ceiling * (1 + 1e-9) + Number.EPSILON;

/**
 * Judge ONE metric for ONE arm against the incumbent.
 *
 * `arm` and `incumbent` are each `[rep1, rep2]` in the metric's natural unit — a rate for the ratio
 * kinds, a FRACTION (0.30, not 30) for the pp kinds.
 *
 * Returns the verdict plus the numbers behind it, because a verdict without its inputs is exactly
 * the kind of claim this file exists to stop.
 */
export function judgeMetric(key, arm, incumbent, extras = {}) {
  const m = METRICS[key];
  if (!m) throw new Error(`unknown metric ${key}`);
  if (!Array.isArray(arm) || arm.length !== 2 || !Array.isArray(incumbent) || incumbent.length !== 2) {
    throw new Error(`${key}: both arms need exactly 2 reps — the spread IS the second rep`);
  }
  // An absolute clause's input must be a real measurement. Checking only `=== undefined` was not
  // enough: `null > 1` and `NaN > 1` are both FALSE, so a failed query coercing to null — the exact
  // omission-shaped value the guard exists to refuse — sailed through as a pass. The clause must be
  // impossible to satisfy by not measuring it, in every shape "not measured" can take.
  if (m.absolute) {
    const v = extras[m.absolute.input];
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(
        `${key}: \`${m.absolute.input}\` must be a non-negative integer, got ${JSON.stringify(v)} — ` +
          `the clause cannot be satisfied by failing to measure it`
      );
    }
  }
  const armMean = mean(arm[0], arm[1]);
  const baseMean = mean(incumbent[0], incumbent[1]);
  const baseSpread = spread(incumbent[0], incumbent[1]);

  // Reduce every kind to: a `value`, one or two `edges`, and which side of each edge is "good".
  // Working in the metric's own units keeps the ceiling and the band commensurable — the bug in the
  // rule this replaced was exactly a units mismatch.
  let value, edges;
  switch (m.kind) {
    case "ratio-lower":
      value = armMean / baseMean;
      edges = [{ at: 1 - m.margin, good: "above" }];
      break;
    case "ratio-upper":
      value = armMean / baseMean;
      edges = [{ at: 1 + m.margin, good: "below" }];
      break;
    case "ratio-both":
      value = armMean / baseMean;
      edges = [
        { at: 1 - m.margin, good: "above" },
        { at: 1 + m.margin, good: "below" },
      ];
      break;
    case "ratio-fall":
      value = armMean / baseMean;
      edges = [{ at: 1 - m.margin, good: "below" }];
      break;
    case "pp-both":
      value = armMean - baseMean;
      edges = [
        { at: -m.margin, good: "above" },
        { at: m.margin, good: "below" },
      ];
      break;
    case "pp-upper":
      value = armMean - baseMean;
      edges = [{ at: m.margin, good: "below" }];
      break;
    default:
      throw new Error(`${key}: unknown kind ${m.kind}`);
  }

  // The spread has to be expressed in the same units as `value`. For the ratio kinds `value` is a
  // ratio against the incumbent's mean, so the spread divides by that mean too; for the pp kinds
  // both are already differences in fractions.
  const tol = m.kind.startsWith("ratio") ? baseSpread / baseMean : baseSpread;

  // Symmetric: PASS must clear EVERY edge by more than the tolerance; FAIL means at least one edge
  // is missed by more than it; anything else is within the noise of an edge.
  const clears = edges.every((e) => (e.good === "above" ? value > e.at + tol : value < e.at - tol));
  const misses = edges.some((e) => (e.good === "above" ? value < e.at - tol : value > e.at + tol));
  let verdict = clears ? VERDICT.PASS : misses ? VERDICT.FAIL : VERDICT.INCONCLUSIVE;

  // The absolute clause is a hard floor and overrides a passing band — never the other way round.
  // Both clauses are floors and the stricter binds, which is what the spec says of Q2.
  let absoluteBreach = null;
  if (m.absolute && extras[m.absolute.input] > m.absolute.max) {
    absoluteBreach = m.absolute.describe(extras[m.absolute.input]);
    verdict = VERDICT.FAIL;
  }

  return { key, label: m.label, verdict, value, armMean, baseMean, baseSpread, tolerance: tol, edges, absoluteBreach };
}

/**
 * Is the SESSION itself trustworthy? Returns the reasons it is not, so an invalid session is
 * reported as broken rather than as a result.
 *
 * Every trigger here is pre-defined and none of them is "the numbers came out wrong" — that
 * distinction is the difference between a rule and an excuse.
 */
export function assessSession({ incumbent, dupeShare, dupeEdges, underpowered, armsCompleted, harnessRefused, crossCheckAvailable }) {
  // REQUIRED, not defaulted-permissive. A default of `armsCompleted = true` means a runner that
  // forgets to pass it silently disarms that validity trigger — the same "omission canonicalized as
  // fine" class as the absolute clause above, in the one file whose job is that the readout cannot
  // be quietly softened. Throw instead: a missing safety input is a bug, not a pass.
  for (const [k, v] of Object.entries({ dupeShare, dupeEdges, underpowered, armsCompleted, harnessRefused, crossCheckAvailable })) {
    if (v === undefined || v === null) throw new Error(`assessSession: \`${k}\` is required — omitting it must not read as valid`);
  }
  // NaN is the other shape of "not measured", and it slipped BOTH dupe gates: `NaN < 0.15` and
  // `NaN > 0.45` are each false, so a broken query produced a clean bill of health. Same reason the
  // absolute clause above rejects it.
  for (const [k, v] of Object.entries({ dupeShare, dupeEdges })) {
    if (!Number.isFinite(v)) throw new Error(`assessSession: \`${k}\` must be a finite number, got ${JSON.stringify(v)}`);
  }
  if (!Array.isArray(underpowered)) throw new Error("assessSession: `underpowered` must be an array — defaulting it to [] reads as \"every metric is powered\"");
  const problems = [];

  if (harnessRefused) problems.push("the cost harness refused the window — drain or cross-check");
  // A null cross-check is NOT a refusal in the harness (it prints "unavailable" and reports ratios
  // anyway), which is precisely why it has to be one here: without ingest_runs.meta.episodes, Q5 is
  // unmeasurable and C1 loses its guard against a retry-rate shift masquerading as a token saving.
  if (!crossCheckAvailable) problems.push("no cross-check: ingest_runs recorded no finished projector run in the window");
  if (!armsCompleted) problems.push("an arm did not complete every episode");
  for (const u of underpowered) problems.push(`${u} is UNDERPOWERED — a corpus too thin to measure is not evidence of a regression`);

  // The incumbent's spread ceiling, per metric, in band units.
  for (const [key, reps] of Object.entries(incumbent ?? {})) {
    const m = METRICS[key];
    if (!m || !Array.isArray(reps) || reps.length !== 2) continue;
    const s = spread(reps[0], reps[1]);
    if (m.maxSpreadRatio !== undefined) {
      const baseMean = mean(reps[0], reps[1]);
      // A near-zero incumbent mean is itself a broken instrument, and the ceiling collapsing with it
      // is the correct behaviour rather than a degeneracy.
      const ceiling = m.maxSpreadRatio * baseMean;
      if (over(s, ceiling)) problems.push(`${key} incumbent spread ${s.toFixed(4)} exceeds ${ceiling.toFixed(4)} (${m.maxSpreadRatio * 100}% of its mean)`);
    } else if (m.maxSpreadPp !== undefined) {
      if (over(s, m.maxSpreadPp)) problems.push(`${key} incumbent spread ${(s * 100).toFixed(2)}pp exceeds ${(m.maxSpreadPp * 100).toFixed(2)}pp`);
    }
  }

  // The incumbent has to be a graph worth comparing against. 0.45 is extraction-health.ts's own
  // DEDUPE_ABSOLUTE_FLOOR; the 0.15 floor is below prod's healthy ~26-35% on purpose, because the
  // battery runs into an EMPTY Neo4j where early episodes have nothing to duplicate against.
  if (dupeShare < DUPE_SANE_MIN || dupeShare > DUPE_SANE_MAX) {
    problems.push(`incumbent duplicate share ${(dupeShare * 100).toFixed(1)}% outside the sane ${DUPE_SANE_MIN * 100}-${DUPE_SANE_MAX * 100}% range`);
  }
  // extraction-health.ts refuses to judge the share below this many edges; so does this.
  if (dupeEdges < MIN_EDGES_FOR_SHARE) {
    problems.push(`only ${dupeEdges} edges — below the ${MIN_EDGES_FOR_SHARE}-edge minimum for a share signal`);
  }

  return { valid: problems.length === 0, problems };
}

/** Mirrors extraction-health.ts's DEDUPE_ABSOLUTE_FLOOR; see assessSession. */
export const DUPE_SANE_MAX = 0.45;
/** Below prod's healthy ~26-35% on purpose — the battery's Neo4j starts empty. */
export const DUPE_SANE_MIN = 0.15;
/** Mirrors extraction-health.ts's MIN_EDGES_FOR_DEDUPE_SIGNAL. */
export const MIN_EDGES_FOR_SHARE = 200;

/**
 * The whole readout: which arm ships, if any.
 *
 * `arms` is ordered — SAME before W1 — and the FIRST arm to pass every gate wins. An arm ships only
 * if every metric PASSes; INCONCLUSIVE blocks exactly as FAIL does.
 */
export function decide({ session, incumbent, arms }) {
  if (!session.valid) {
    return { outcome: "INVALID", reasons: session.problems, arms: [] };
  }
  const judged = arms.map(({ name, metrics, extras = {} }) => {
    const results = Object.keys(METRICS).map((key) => judgeMetric(key, metrics[key], incumbent[key], extras));
    const blocking = results.filter((r) => r.verdict !== VERDICT.PASS);
    return { name, results, ships: blocking.length === 0, blocking };
  });
  const winner = judged.find((a) => a.ships);
  return {
    outcome: winner ? "SHIP" : "NO_SHIP",
    winner: winner?.name ?? null,
    arms: judged,
    reasons: winner ? [] : ["no arm cleared every gate — the negative result is committed to the spec"],
  };
}
