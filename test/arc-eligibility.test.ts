import { describe, expect, it } from "vitest";
import { isArcActiveLinearState, isArcEligible } from "@/lib/graph/arc-eligibility";

/**
 * Spec: only ACTIVE Linear work (In Progress / In Review) informs narrative arcs; other states are
 * context, not narrative. Non-Linear content is never status-gated. Pure, no DB.
 */

describe("isArcActiveLinearState", () => {
  it("treats In Progress / In Review (+ Reviewing) as active", () => {
    expect(isArcActiveLinearState("In Progress")).toBe(true);
    expect(isArcActiveLinearState("In Review")).toBe(true);
    expect(isArcActiveLinearState("Reviewing")).toBe(true);
  });
  it("treats Backlog / Todo / Done / Canceled as NOT active", () => {
    for (const s of ["Backlog", "Todo", "Done", "Canceled", "Duplicate"]) {
      expect(isArcActiveLinearState(s)).toBe(false);
    }
  });
});

describe("isArcEligible", () => {
  it("gates ONLY Linear items by status; everything else is always eligible", () => {
    expect(isArcEligible("git", "whatever")).toBe(true);
    expect(isArcEligible("notion", null)).toBe(true);
    expect(isArcEligible(null, null)).toBe(true); // unknown source → eligible
  });
  it("prefers the canonical state_type ('started' = active) over the display name", () => {
    // A completed-type state NAMED "Reviewed" (name regex would keep it) is correctly dropped by type.
    expect(isArcEligible("linear", "Reviewed", "completed")).toBe(false);
    // A started-type state with an unusual name ("Doing"/"Blocked") the name regex would miss → kept.
    expect(isArcEligible("linear", "Blocked", "started")).toBe(true);
    expect(isArcEligible("linear", "In Progress", "started")).toBe(true);
    expect(isArcEligible("linear", "Backlog", "backlog")).toBe(false);
  });
  it("falls back to the state-name regex when no state_type is present (pre-migration rows)", () => {
    expect(isArcEligible("linear", "In Progress")).toBe(true);
    expect(isArcEligible("linear", "In Review", "")).toBe(true);
    expect(isArcEligible("linear", "Backlog")).toBe(false);
    expect(isArcEligible("linear", null)).toBe(false); // Linear + no type + no state → not active
    expect(isArcEligible("LINEAR", "Backlog")).toBe(false); // source case-insensitive
  });
});
