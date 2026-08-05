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
 *
 * AMENDED 2026-08-05 (AIO-805): the banner now carries TWO periods. The lifetime gap keeps the floor
 * claim — it is still permanently elevated by that July block — but it can never answer "is spend
 * escaping the meter NOW", so the month became the headline. Measured the morning it shipped: 0.9%
 * for the month against 22% lifetime, on the same key. The guard follows the lesson, not the
 * sentence: whatever is claimed to have a floor must be the LIFETIME figure, and the actionable
 * signal must be the one that can actually move.
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

  it("binds the never-clears claim to the LIFETIME dollars, not the percentage", () => {
    // The fraction is (provider - ledger) / provider, and both legs are lifetime — so as new fully
    // metered spend accrues, the fixed pre-metering block is diluted and the PERCENTAGE falls on its
    // own. Only the dollar amount has a floor. The first version of this banner promised the
    // percentage could not fall, which would have read as the banner lying about arithmetic within a
    // few months — the credibility failure this whole change exists to avoid.
    expect(page).toMatch(/lifetime gap has a floor/i);
    expect(page, "must not resurrect the false claim about the percentage").not.toMatch(
      /percentage will not fall/i
    );
  });

  it("renders the month INDEPENDENTLY of the lifetime state — not nested inside its amber branch", () => {
    // The defect this pins: the month block first shipped inside `reconciliation.status ===
    // "unattributed"`, so it vanished whenever lifetime read `reconciled` (dilution) or
    // `ledger-exceeds` (a rotated key) — i.e. precisely when someone would be watching for live
    // leakage. Pinning the copy could not see it: every string was present in the source while the
    // branch was unreachable ("never attest a surface that does not render").
    const lifetimeBranch = page.indexOf('reconciliation.status === "unattributed" ?');
    const lifetimeBlockEnd = page.indexOf("      ) : null}", lifetimeBranch);
    const monthBlock = page.indexOf("{monthReconciliation ? (");
    expect(lifetimeBranch, "lifetime branch not found — guard is looking at the wrong shape").toBeGreaterThan(-1);
    expect(monthBlock, "month block not found").toBeGreaterThan(-1);
    // Without this, a refactor that removes the ternary close (a lint autofix to `&&`-style
    // conditionals does exactly that) makes indexOf return -1, and the sibling assertion below
    // degenerates to `monthBlock > -1` — always true. The guard would disarm SILENTLY, which is
    // worse than breaking: re-anchor it deliberately rather than let it pass on nothing.
    expect(
      lifetimeBlockEnd,
      "close anchor not found — re-anchor this guard rather than letting it pass vacuously"
    ).toBeGreaterThan(-1);
    expect(monthBlock, "the month block must be a SIBLING of the lifetime banner, not nested in it").toBeGreaterThan(
      lifetimeBlockEnd
    );
  });

  it("gives the month its own copy states rather than reusing the lifetime explanations", () => {
    // A month in `ledger-exceeds` is a boundary skew, NOT the key rotation the lifetime copy blames —
    // and folding it into the reassuring branch renders "a near-zero gap" beside numbers that
    // contradict it.
    expect(page).toMatch(/month-boundary\s*\n?\s*skew|month-boundary skew/i);
    expect(page, "must not blame key rotation for a month skew").not.toMatch(
      /month[\s\S]{0,200}key was rotated/i
    );
  });

  it("makes the CURRENT-PERIOD gap the actionable signal, since only it can move", () => {
    // The point of the amendment: a figure with a permanent floor cannot be an alarm. The month can,
    // and the copy must say which one to watch — otherwise the operator is back to reading a number
    // that no action of theirs will ever change.
    expect(page).toMatch(/month gap that grows is the real signal/i);
    // Both legs must be the provider's calendar month, not our selected window — a boundary mismatch
    // would manufacture a gap out of a timezone.
    expect(page).toMatch(/provider&apos;s calendar month|provider's calendar month/i);
    expect(page).toContain("getLedgerMonthUsd");
  });

  it("still points at the failed-attempt breakdown for the part that IS actionable", () => {
    // Anchored on wording unique to the BANNER. "failed attempts" alone also appears in the By-feature
    // help text, so this assertion passed even with the banner's bullet deleted — vacuous against the
    // one thing it was written to protect.
    expect(page).toMatch(/counted per feature<\/em> as failed attempts below/i);
  });
});
