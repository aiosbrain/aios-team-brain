import { describe, expect, it } from "vitest";
import {
  deriveDedupePollution,
  DEDUPE_ABSOLUTE_FLOOR,
  DEDUPE_MARGIN,
  MIN_EDGES_FOR_DEDUPE_SIGNAL,
} from "@/lib/graph/extraction-health";

/**
 * Spec: catch an extraction model that resolves entity identity badly — the failure no static check
 * can predict, because no catalogue exposes it.
 *
 * The numbers here are real. `lib/graph/learning.ts` measured ~26% of this graph as `IS_DUPLICATE_OF`
 * edges on 2026-07-20, on a HEALTHY extractor, and filters them from every read as bookkeeping.
 * Sampling on 2026-08-03 put pre-07-30 edges at ~35% and the bad model's at ~70%. So "any duplicate
 * edges" is the healthy steady state, and only a rate change against the graph's own history is signal.
 *
 * Every uncertain case must return NOT polluted. An alarm that fires on an outage, a fresh install, or
 * a quiet week is one people learn to dismiss — which this repo has paid for twice already.
 */

const sig = (recentDupe: number, recentTotal: number, baselineDupe: number, baselineTotal: number) => ({
  recentDupe,
  recentTotal,
  baselineDupe,
  baselineTotal,
});

describe("deriveDedupePollution — the real incident", () => {
  it("flags the 2026-07-30 shape: ~35% baseline, ~70% recent", () => {
    const out = deriveDedupePollution(sig(700, 1000, 350, 1000));
    expect(out.polluted).toBe(true);
    expect(out.recentShare).toBeCloseTo(0.7, 3);
    expect(out.baselineShare).toBeCloseTo(0.35, 3);
    expect(out.reason).toMatch(/duplicate entities/i);
    // The message must name the action, not just the observation.
    expect(out.reason).toMatch(/Extraction model/i);
  });

  it("does NOT flag the healthy steady state, however high it looks in absolute terms", () => {
    // ~26% is what a GOOD extractor produces here. An absolute threshold would fire forever.
    const out = deriveDedupePollution(sig(260, 1000, 260, 1000));
    expect(out.polluted, "the healthy baseline must never be an alarm").toBe(false);
  });

  it("does not flag a graph that has always run hot — self-calibrating, not absolute", () => {
    // 60% recent would trip any fixed threshold, but this graph has always been at 60%.
    expect(deriveDedupePollution(sig(600, 1000, 600, 1000)).polluted).toBe(false);
  });
});

describe("deriveDedupePollution — refuses to judge what it cannot", () => {
  it("unknown (Neo4j unreadable) is NOT degraded — and says so via `judgeable`", () => {
    const out = deriveDedupePollution({ recentDupe: null, recentTotal: null, baselineDupe: null, baselineTotal: null });
    expect(out.polluted).toBe(false);
    expect(out.judgeable, "a refusal must be distinguishable from a judged 'healthy'").toBe(false);
  });

  it("a sample below the floor cannot carry a verdict", () => {
    // 100% recent duplicates — but over 3 edges. A fresh install, not a regression.
    const tiny = deriveDedupePollution(sig(3, 3, 100, 1000));
    expect(tiny.polluted).toBe(false);
    // The refusal is explicit: shares are computed (they exist for display) but carry no verdict.
    // The alarm's edge machine keys on THIS — a quiet day during a sustained incident must not
    // read as a judged recovery (review finding on the delivery half).
    expect(tiny.judgeable).toBe(false);
    expect(tiny.recentShare).not.toBeNull();
    // …and the same ratio over a real sample DOES flag, so the floor is what's doing the work.
    expect(deriveDedupePollution(sig(MIN_EDGES_FOR_DEDUPE_SIGNAL, MIN_EDGES_FOR_DEDUPE_SIGNAL, 100, 1000)).polluted).toBe(true);
  });

  it("no baseline to compare against is NOT degraded", () => {
    // A graph younger than the baseline window has no history to be judged against.
    expect(deriveDedupePollution(sig(900, 1000, 2, 5)).polluted).toBe(false);
  });

  it("an empty recent window is not a verdict either", () => {
    expect(deriveDedupePollution(sig(0, 0, 300, 1000)).polluted).toBe(false);
  });
});

describe("deriveDedupePollution — both conditions are load-bearing", () => {
  it("a big RELATIVE rise off a tiny baseline does not fire", () => {
    // 2% → 6% is a 3x rise and completely meaningless. The absolute floor is what stops it.
    const out = deriveDedupePollution(sig(60, 1000, 20, 1000));
    expect(out.recentShare! / out.baselineShare!).toBeGreaterThan(DEDUPE_MARGIN);
    expect(out.polluted, "a relative margin alone fires on noise").toBe(false);
  });

  it("a high share that is NOT a rise does not fire — but IS a judged verdict", () => {
    const out = deriveDedupePollution(sig(500, 1000, 480, 1000));
    expect(out.recentShare!).toBeGreaterThan(DEDUPE_ABSOLUTE_FLOOR);
    expect(out.polluted, "high-but-flat is the model's nature, not a regression").toBe(false);
    // Judged-healthy, not refused: this CAN clear an active alarm, where a refusal cannot.
    expect(out.judgeable).toBe(true);
  });

  it("needs BOTH: above the floor AND above the baseline by the margin", () => {
    expect(deriveDedupePollution(sig(500, 1000, 300, 1000)).polluted).toBe(true); // 50% vs 30% = 1.67x
    expect(deriveDedupePollution(sig(440, 1000, 300, 1000)).polluted).toBe(false); // 44% — under the floor
    expect(deriveDedupePollution(sig(500, 1000, 400, 1000)).polluted).toBe(false); // 1.25x — under the margin
  });
});
