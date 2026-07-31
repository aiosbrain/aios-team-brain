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

  it("binds the never-clears claim to the DOLLARS, not the percentage", () => {
    // The fraction is (provider - ledger) / provider, and both legs are lifetime — so as new fully
    // metered spend accrues, the fixed pre-metering block is diluted and the PERCENTAGE falls on its
    // own. Only the dollar amount has a floor. The first version of this banner promised the
    // percentage could not fall, which would have read as the banner lying about arithmetic within a
    // few months — the credibility failure this whole change exists to avoid.
    expect(page).toMatch(/dollar gap here has a floor/i);
    expect(page).toMatch(/dollars grow/i);
    expect(page, "must not resurrect the false claim about the percentage").not.toMatch(
      /percentage will not fall/i
    );
  });

  it("still points at the failed-attempt breakdown for the part that IS actionable", () => {
    // Anchored on wording unique to the BANNER. "failed attempts" alone also appears in the By-feature
    // help text, so this assertion passed even with the banner's bullet deleted — vacuous against the
    // one thing it was written to protect.
    expect(page).toMatch(/counted per feature<\/em> as failed attempts below/i);
  });
});
