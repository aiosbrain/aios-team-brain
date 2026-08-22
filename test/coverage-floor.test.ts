import { describe, expect, it } from "vitest";
import { shapeCoverage } from "@/lib/projects/context/coverage";

/**
 * AUDITFIX-15A AC9 — the FLOOR semantics of `truncated`, at the boundary.
 *
 * The dm criterion only asserted `truncated === false` on a small fixture, which a mutation forcing
 * `truncated = false` passes. The contract lives at the boundary — exactly `max` is an EXACT count,
 * one more is a FLOOR — and that boundary was untestable while the shaping was inline, because
 * reaching it meant planting 5,001 rows in Postgres. Hence the pure function.
 */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i}`, path: `p-${i}.md` }));

describe("coverage floor semantics", () => {
  it("exactly `max` results is an EXACT count, not a floor", () => {
    const r = shapeCoverage(rows(5), 100, 5);
    expect(r.truncated).toBe(false);
    expect(r.count).toBe(5);
  });

  it("one MORE than `max` is a FLOOR, and the count is clamped to `max`", () => {
    const r = shapeCoverage(rows(6), 100, 5);
    expect(r.truncated, "the caller queries max+1 precisely so this is distinguishable").toBe(true);
    expect(r.count, "a floor reports the bound, never the queried extra").toBe(5);
  });

  it("`truncated` implies a non-zero count — which is what makes the removed access-health arm dead", () => {
    // `access-health.ts` dropped its `else if (truncated)` branch on this implication. If it ever
    // stops holding, that branch was deleted wrongly and this test is where it shows up.
    for (const n of [0, 1, 5, 6, 11]) {
      const r = shapeCoverage(rows(n), 100, 5);
      if (r.truncated) expect(r.count).toBeGreaterThan(0);
    }
  });

  it("examples never exceed the example limit, even at a floor", () => {
    expect(shapeCoverage(rows(50), 100, 40).examples).toHaveLength(5);
  });

  it("an empty result is exact, never a floor", () => {
    const r = shapeCoverage([], 2900, 5);
    expect(r).toEqual({ scanned: 2900, count: 0, examples: [], truncated: false });
  });
});
