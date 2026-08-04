import { describe, expect, it } from "vitest";
import { foldGraphEfficiency, HEALTHY_CALLS_PER_EPISODE } from "@/lib/metrics/graph-efficiency";

/**
 * Spec: calls-per-episode is the number that catches a bad extraction model, and cost-per-call is the
 * number that hides one.
 *
 * Measured on prod 2026-07-30 → 08-02: the extraction model was swapped for one 10x cheaper per call,
 * and over three days calls/episode ran 18.9 → 28.1 → 39.8 → 49.4 while total spend FELL (episode
 * volume dropped faster than the ratio rose). Every dashboard number went the right way while the
 * per-episode economics went the wrong way. These pin the arithmetic that makes that visible.
 */

const calls = (day: string, count: number, costPerCall = 0.001) => ({
  day,
  calls: count,
  costUsd: count * costPerCall,
});
// `meta.episodes` is the denominator — the count actually pushed to Graphiti. `created` (items) is
// deliberately NOT used: an item chunks into up to 16 episodes, so a per-item ratio tracks the corpus's
// chunk mix rather than the model.
const run = (day: string, episodes: number) => ({ started_at: `${day}T12:00:00Z`, meta: { episodes } });
/** A run recorded before the episode counter existed — an UNKNOWN denominator, not a zero. */
const legacyRun = (day: string, items: number) => ({ started_at: `${day}T12:00:00Z`, meta: { scanned: items } });

describe("foldGraphEfficiency", () => {
  it("divides calls by EPISODES PUSHED, per UTC day", () => {
    const out = foldGraphEfficiency(
      [calls("2026-08-01", 20)],
      [run("2026-08-01", 4)]
    );
    expect(out.days).toHaveLength(1);
    expect(out.days[0]).toMatchObject({ episodes: 4, calls: 20, callsPerEpisode: 5 });
    expect(out.callsPerEpisode).toBe(5);
  });

  it("sums MANY runs in a day — the projector ticks hourly, not once", () => {
    const out = foldGraphEfficiency(
      [calls("2026-08-01", 30)],
      [run("2026-08-01", 3), run("2026-08-01", 4), run("2026-08-01", 3)]
    );
    expect(out.days[0].episodes).toBe(10);
    expect(out.days[0].callsPerEpisode).toBe(3);
  });

  it("a day with no episodes has an UNKNOWN ratio, not a zero", () => {
    // Calls with no episodes pushed is a real state (a queue draining after the projector stopped).
    // Rendering 0 would read as "perfectly efficient" — the opposite of the truth.
    const out = foldGraphEfficiency([calls("2026-08-01", 1)], []);
    expect(out.days[0].callsPerEpisode).toBeNull();
    expect(out.days[0].costPerEpisode).toBeNull();
    expect(out.callsPerEpisode).toBeNull();
  });

  it("flags a ratio that is BOTH unhealthy and RISING", () => {
    // The real shape: work per episode grows with the graph because dedupe is failing, so each new
    // episode is resolved against more nodes. Compounding, not a flat tax.
    const rows = [calls("2026-07-30", 19), calls("2026-07-31", 28), calls("2026-08-01", 40), calls("2026-08-02", 49)];
    const runs = [run("2026-07-30", 1), run("2026-07-31", 1), run("2026-08-01", 1), run("2026-08-02", 1)];
    // 19,28 → 40,49: the second half is 1.9x the first, well clear of the noise margin.
    expect(foldGraphEfficiency(rows, runs).degrading).toBe(true);
  });

  it("does NOT flag a high but FLAT ratio — a constant overhead is the model, not a leak", () => {
    const rows = ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"].map((d) => calls(d, 20));
    const runs = ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"].map((d) => run(d, 1));
    const out = foldGraphEfficiency(rows, runs);
    expect(out.callsPerEpisode).toBe(20);
    expect(out.callsPerEpisode!).toBeGreaterThan(HEALTHY_CALLS_PER_EPISODE);
    expect(out.degrading, "flat is not degrading — nagging about it teaches people to ignore it").toBe(false);
  });

  it("does NOT flag a rising ratio that is still healthy", () => {
    const out = foldGraphEfficiency(
      [calls("2026-08-01", 2), calls("2026-08-02", 5)],
      [run("2026-08-01", 1), run("2026-08-02", 1)]
    );
    expect(out.degrading).toBe(false);
  });

  it("an idle day cannot fake an improvement", () => {
    // DECISIVE fixture: with the idle day EXCLUDED the halves are [40] vs [50, 60] → rising. If it were
    // averaged in as a 0 ratio the second half becomes [0, 50, 60] → mean 36.7 < 40 → not rising, and
    // a real climb would be hidden. The first version of this test passed either way — it proved
    // nothing about the filter it was written for.
    const rows = [calls("2026-08-01", 40), calls("2026-08-03", 50), calls("2026-08-04", 60)];
    const runs = [run("2026-08-01", 1), run("2026-08-02", 0), run("2026-08-03", 1), run("2026-08-04", 1)];
    expect(foldGraphEfficiency(rows, runs).degrading).toBe(true);
  });

  it("a run with no episode count is SKIPPED, not counted as zero", () => {
    // Runs recorded before the counter shipped have no `meta.episodes`. Treating them as 0 would leave
    // their calls divided by the other runs' episodes — inflating the ratio and inventing a regression.
    const out = foldGraphEfficiency(
      [calls("2026-08-01", 10)],
      [run("2026-08-01", 5), legacyRun("2026-08-01", 999)]
    );
    expect(out.days[0].episodes).toBe(5);
    expect(out.callsPerEpisode).toBe(2);
  });

  it("a day with ONLY legacy runs has an unknown ratio", () => {
    const out = foldGraphEfficiency([calls("2026-08-01", 1)], [legacyRun("2026-08-01", 40)]);
    expect(out.callsPerEpisode).toBeNull();
  });

  it("needs a real margin and enough days — noise is not a trend", () => {
    const runs3 = ["2026-08-01", "2026-08-02", "2026-08-03"].map((d) => run(d, 1));
    // 20 → 21 → 22: above healthy and technically rising, but well inside noise.
    const noisy = [calls("2026-08-01", 20), calls("2026-08-02", 21), calls("2026-08-03", 22)];
    expect(foldGraphEfficiency(noisy, runs3).degrading, "a stable model must not nag").toBe(false);
    // Two days can't establish a trend, however steep.
    expect(
      foldGraphEfficiency(
        [calls("2026-08-01", 10), calls("2026-08-02", 90)],
        [run("2026-08-01", 1), run("2026-08-02", 1)]
      ).degrading
    ).toBe(false);
  });

  it("carries cost per episode alongside — the ratio explains it, the dollars size it", () => {
    const out = foldGraphEfficiency(
      [calls("2026-08-01", 10, 0.002)],
      [run("2026-08-01", 5)]
    );
    expect(out.costPerEpisode).toBeCloseTo(0.004, 6);
  });
});

describe("truncated denominator (AIO-798)", () => {
  it("a capped ingest_runs fetch surfaces as truncated — price consumers withhold, never fabricate", () => {
    const out = foldGraphEfficiency([], [], true);
    expect(out.truncated).toBe(true);
  });

  it("defaults to not truncated", () => {
    expect(foldGraphEfficiency([], []).truncated).toBe(false);
  });
});
