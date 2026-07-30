import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * GUARD: per-feature failed attempts must actually reach the screen.
 *
 * The whole point of `llm_failures` is answering "WHICH feature lost the money" — a total with no
 * attribution is the anonymous remainder it replaced. The data layer computed `failed_attempts` per
 * source and the chart never read it: every test passed, the map and the commit message both claimed
 * "per feature", and the page showed a bare $0.00 bar for a feature that had only failures. Nothing
 * behavioural would ever have caught that, so it is pinned here.
 */
describe("guard: failed attempts are surfaced, per feature and in total", () => {
  const root = join(import.meta.dirname, "..", "..");
  const chart = readFileSync(join(root, "components", "charts", "cost-breakdown.tsx"), "utf8");
  const page = readFileSync(join(root, "app", "t", "[team]", "costs", "page.tsx"), "utf8");

  it("the by-feature chart reads the per-slice count", () => {
    expect(chart, "the slice carries failed_attempts but nothing renders it").toContain("failed_attempts");
  });

  it("the page shows the window total", () => {
    expect(page).toContain("failed_attempts");
  });

  it("truncation is rendered as a floor, never as an exact count", () => {
    // Failures arrive in storms — precisely when a silently truncated count would understate the
    // number being looked at.
    expect(page).toContain("failed_truncated");
    expect(page).toContain("≥");
  });
});
