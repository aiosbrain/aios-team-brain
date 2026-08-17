import { describe, it, expect } from "vitest";
import { detectMisfitThresholds, type ObservedCadence } from "@/lib/ingest/threshold-fit";
import { staleThresholdMs } from "@/lib/ingest/pipeline-health";

const H = 60 * 60 * 1000;
const MIN = 60 * 1000;

/**
 * BANNERFLAP-2 (`docs/design/staleness-threshold-fit.md`). Hand-fitting the staleness thresholds has
 * failed six times, each recurrence found by a human noticing a loud banner naming a healthy job. The
 * detector turns that into a number; these tests are its consumer today.
 *
 * The second block is the one that earns its place long-term: it feeds the ACTUAL measured prod
 * cadences to the SHIPPED `staleThresholdMs`, so narrowing any bar below a measured gap reddens the
 * suite instead of reddening the banner.
 */

/**
 * Measured on prod, 2026-08-18, over 7 days of `ingest_runs` with `trigger='scheduler'` — the same
 * filter `getPipelineHealth`'s staleness clock uses. Literal measurements, NOT derived from the
 * constants under test: seeding a fixture from the thing it is meant to check makes the check vacuous.
 *
 * EVERY source with at least two scheduler runs in that window is here, including the `null`-threshold
 * legs (skipped by the detector, but their presence is what proves the skip is real on live numbers —
 * `doc_task_infer` and `dense` sit at ~35h gaps while perfectly healthy) and `auth_cleanup`, the only
 * other FINITE threshold. An earlier draft of this fixture listed seven hand-picked legs and claimed
 * to be complete; `auth_cleanup`'s absence meant the "reports NONE under the shipped thresholds" test
 * below never checked the 26h bar at all.
 *
 * A caution the numbers themselves taught: a measurement taken hours earlier put
 * `context_backfill[_all]` at 235 min, and a 5h bar was fitted to it — 7 minutes of grace over the
 * real 293-min worst case. Re-measure before narrowing anything here.
 */
const MEASURED: Record<string, ObservedCadence> = {
  meeting_notes: { worstGapMs: 293 * MIN, p95GapMs: 78 * MIN, runs: 300 },
  context_backfill: { worstGapMs: 293 * MIN, p95GapMs: 78 * MIN, runs: 276 },
  context_backfill_all: { worstGapMs: 293 * MIN, p95GapMs: 78 * MIN, runs: 276 },
  auth_cleanup: { worstGapMs: 1467 * MIN, p95GapMs: 1464 * MIN, runs: 7 },
  github: { worstGapMs: 95 * MIN, p95GapMs: 39 * MIN, runs: 325 },
  access_bootstrap: { worstGapMs: 86 * MIN, p95GapMs: 39 * MIN, runs: 309 },
  linear: { worstGapMs: 30 * MIN, p95GapMs: 30 * MIN, runs: 365 },
  slack: { worstGapMs: 30 * MIN, p95GapMs: 30 * MIN, runs: 366 },
  doc_task_infer: { worstGapMs: 2108 * MIN, p95GapMs: 1629 * MIN, runs: 10 },
  dense: { worstGapMs: 2107 * MIN, p95GapMs: 671 * MIN, runs: 39 },
  graph_project: { worstGapMs: 69 * MIN, p95GapMs: 61 * MIN, runs: 182 },
  linear_inbound: { worstGapMs: 60 * MIN, p95GapMs: 30 * MIN, runs: 361 },
};

/**
 * `STALE_MS_BY_SOURCE` as it stood BEFORE this change — the state that produced the live complaint
 * ("three ingestion legs are broken", gone on reload). Transcribed from the map at `main`, not
 * paraphrased: `auth_cleanup` was the only fitted leg, everything else fell to the 3h default or was
 * explicitly `null`.
 */
const BEFORE_NULL = new Set(["llm", "scan", "pm_sync", "dense", "linear_inbound", "graph_project", "arcs", "doc_task_infer"]);
const thresholdBefore = (source: string): number | null =>
  BEFORE_NULL.has(source) ? null : source === "auth_cleanup" ? 26 * H : 3 * H;

describe("detectMisfitThresholds — the behaviour", () => {
  it("flags a leg whose worst gap reaches its threshold, and leaves one comfortably inside it alone", () => {
    const found = detectMisfitThresholds(
      {
        late: { worstGapMs: 4 * H, p95GapMs: 30 * MIN, runs: 100 },
        fine: { worstGapMs: 30 * MIN, p95GapMs: 20 * MIN, runs: 100 },
      },
      () => 3 * H
    );
    expect(found.map((f) => f.source)).toEqual(["late"]);
    expect(found[0]).toMatchObject({ thresholdMs: 3 * H, worstGapMs: 4 * H, runs: 100 });
  });

  it("flags a gap that lands EXACTLY on the threshold — at-or-above, not strictly above", () => {
    // The boundary is deliberate. A leg whose worst gap equals its bar is already spending time
    // indistinguishable from broken (the banner fires at `now - clock > threshold`, and the next
    // slightly-slower tick crosses it). This is a diagnostic, so the inclusive side is the safe one.
    const found = detectMisfitThresholds({ onTheBar: { worstGapMs: 3 * H, p95GapMs: 1 * H, runs: 50 } }, () => 3 * H);
    expect(found.map((f) => f.source)).toEqual(["onTheBar"]);
  });

  it("reports NOTHING for a null-threshold leg — a leg that is never aged cannot be mis-fitted", () => {
    // The direction that matters: `dense`/`arcs`/`doc_task_infer` write a row only when there IS work,
    // so their gaps are unbounded by design. A detector that flagged them would produce permanent
    // noise about legs whose answer is already "never age this", and be ignored within a week.
    const found = detectMisfitThresholds(
      { dense: { worstGapMs: 40 * H, p95GapMs: 30 * H, runs: 12 } },
      () => null
    );
    expect(found).toEqual([]);
  });

  it("separates a chronic mis-fit from a single tail excursion", () => {
    const found = detectMisfitThresholds(
      {
        tail: { worstGapMs: 4 * H, p95GapMs: 30 * MIN, runs: 100 }, // one slow week
        chronic: { worstGapMs: 5 * H, p95GapMs: 4 * H, runs: 100 }, // the bar is simply wrong
      },
      () => 3 * H
    );
    expect(found.find((f) => f.source === "tail")?.chronic).toBe(false);
    expect(found.find((f) => f.source === "chronic")?.chronic).toBe(true);
  });

  it("cannot assess a leg with fewer than two runs — one run yields no gap at all", () => {
    // Structural, not a sample-size policy: a "needs N runs before we say anything" knob would fail in
    // the silent direction this module exists to avoid.
    expect(
      detectMisfitThresholds({ brandNew: { worstGapMs: 9 * H, p95GapMs: 9 * H, runs: 1 } }, () => 3 * H)
    ).toEqual([]);
  });

  it("orders by worst overshoot, so the leg costing the most red is first", () => {
    const found = detectMisfitThresholds(
      {
        mild: { worstGapMs: 3.5 * H, p95GapMs: 1 * H, runs: 50 },
        severe: { worstGapMs: 9 * H, p95GapMs: 1 * H, runs: 50 },
      },
      () => 3 * H
    );
    expect(found.map((f) => f.source)).toEqual(["severe", "mild"]);
  });

  it("does NOT suggest a replacement threshold — widening a bar stays a human edit", () => {
    // The rejected design, pinned. Auto-deriving each threshold from the leg's own cadence fails in the
    // DANGEROUS direction: a leg degrading gradually raises its own bar and goes silent. A finding
    // therefore carries observations only. If a `suggestedMs`-shaped field ever appears here, that
    // decision is being reversed by accident.
    const [finding] = detectMisfitThresholds(
      { late: { worstGapMs: 4 * H, p95GapMs: 30 * MIN, runs: 100 } },
      () => 3 * H
    );
    expect(Object.keys(finding).sort()).toEqual(
      ["chronic", "p95GapMs", "runs", "source", "thresholdMs", "worstGapMs"]
    );
  });
});

describe("detectMisfitThresholds — against the real measured cadences", () => {
  it("reports all THREE mis-fits under the PRE-change thresholds", () => {
    // Demonstrated against the real numbers rather than asserted. Three, not two: the first draft of
    // the spec fitted `meeting_notes` and `context_backfill` and would have shipped with
    // `context_backfill_all` — same invocation, identical gaps — still flapping.
    const found = detectMisfitThresholds(MEASURED, thresholdBefore);
    expect(found.map((f) => f.source).sort()).toEqual([
      "context_backfill",
      "context_backfill_all",
      "meeting_notes",
    ]);
    // …and none of them chronic: p95 is 78 min against a 3h bar. These are TAIL excursions, which is
    // exactly why the banner flapped rather than staying red — and why the user saw it clear on a
    // reload.
    expect(found.filter((f) => f.chronic)).toEqual([]);
    // The `null`-threshold legs are in MEASURED with gaps up to 35h and must STILL be silent — the
    // fixture now contains the legs most able to produce a false positive, so the skip is proven on
    // live numbers rather than on a hand-made one.
    expect(found.map((f) => f.source)).not.toContain("doc_task_infer");
    expect(found.map((f) => f.source)).not.toContain("dense");
  });

  it("reports NONE under the shipped thresholds — and reddens if any bar is narrowed below a measured gap", () => {
    expect(detectMisfitThresholds(MEASURED, staleThresholdMs)).toEqual([]);
  });

  it("covers EVERY finite threshold in the shipped map, so no fitted bar escapes the check above", () => {
    // The hole this closes, found in review: the fixture used to omit `auth_cleanup`, the only other
    // finite bar. A missed daily run would put its gap past 26h and the "reports NONE" test would not
    // have noticed. Rather than trusting the fixture to stay complete, derive the requirement.
    const finiteInMap = Object.keys(MEASURED).filter((s) => staleThresholdMs(s) !== null);
    expect(finiteInMap.sort()).toEqual([
      "access_bootstrap",
      "auth_cleanup",
      "context_backfill",
      "context_backfill_all",
      "github",
      "linear",
      "meeting_notes",
      "slack",
    ]);
    // …and each has real headroom, stated as a ratio so it survives a units change. NOTE `auth_cleanup`
    // sits at 0.94 — 93 minutes of grace on a 26h bar, the tightest fit in the map and a genuine
    // near-miss this fixture now makes visible. If a measurement pushes it over, that is the check
    // working: re-fit it, do not raise this number.
    for (const s of finiteInMap) {
      expect(MEASURED[s].worstGapMs / staleThresholdMs(s)!, `${s} is fitted too tight`).toBeLessThan(0.95);
    }
  });
});

describe("detectMisfitThresholds — degenerate thresholds", () => {
  it("skips a non-finite threshold instead of emitting a NaN finding", () => {
    // NaN is false against BOTH the null check and the `<` comparison, so a broken constant would
    // otherwise produce a finding whose every number is NaN and whose sort key poisons the comparator.
    // Unreachable through `staleThresholdMs` today (literal constants only) — closed rather than
    // trusted, because this map is precisely the thing the module exists to be suspicious of.
    expect(
      detectMisfitThresholds({ broken: { worstGapMs: 9 * H, p95GapMs: 9 * H, runs: 50 } }, () => Number.NaN)
    ).toEqual([]);
  });
});
