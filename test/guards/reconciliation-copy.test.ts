import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: the reconciliation banner must name the cause it can never fix, and must tell the operator to
 * read the TREND rather than the level.
 *
 * Measured 2026-07-31 against OpenRouter's own per-day figures: of a $46.23 gap, $29.25 was spend from
 * 2026-07-28 — the graph proxy was live, the graph meter was not yet — and only $10.46 was failed calls.
 * That first block can never enter this ledger, so the percentage is permanently elevated with nothing
 * wrong. A banner that reads as a live alarm and can never be cleared trains the reader to ignore it,
 * which is precisely how the work-key check earned its reputation.
 *
 * The wording is the whole feature here, so it is pinned rather than left to a future tidy-up.
 */
describe("guard: the reconciliation banner explains the permanent floor", () => {
  const page = readFileSync(
    join(import.meta.dirname, "..", "..", "app", "t", "[team]", "costs", "page.tsx"),
    "utf8"
  );

  it("names pre-metering spend as a cause", () => {
    expect(page).toMatch(/before metering existed/i);
    // Dated from the ledger's own first row, never hardcoded — a wrong date is worse than none.
    expect(page).toContain("breakdown.trackingSince");
  });

  it("says the number will not fall, and to watch whether it grows", () => {
    expect(page).toMatch(/will not fall/i);
    expect(page).toMatch(/grows/i);
  });

  it("still points at the failed-attempt breakdown for the part that IS actionable", () => {
    expect(page).toMatch(/failed attempts/i);
  });
});
