import { describe, expect, it } from "vitest";
import { violatesEvidenceTier } from "@/lib/social/tier";

/**
 * Spec for the evidence→tier-leak rule (CLAUDE.md §5): an opportunity may be at most as public as
 * its most-restrictive evidence. Derived from the leak we're preventing (internal knowledge →
 * public post), not the implementation.
 */
describe("violatesEvidenceTier", () => {
  it("blocks an external opportunity built on any team evidence", () => {
    expect(violatesEvidenceTier("external", ["team"], 0)).toBe(true);
    expect(violatesEvidenceTier("external", ["external", "team"], 0)).toBe(true);
  });

  it("allows an external opportunity when all evidence is external", () => {
    expect(violatesEvidenceTier("external", ["external", "external"], 0)).toBe(false);
  });

  it("allows a team opportunity regardless of evidence (team is the safe floor)", () => {
    expect(violatesEvidenceTier("team", ["team"], 0)).toBe(false);
    expect(violatesEvidenceTier("team", ["external"], 0)).toBe(false);
  });

  it("fails closed on unresolved evidence — treats missing items as restrictive", () => {
    expect(violatesEvidenceTier("external", [], 1)).toBe(true);
    expect(violatesEvidenceTier("external", ["external"], 1)).toBe(true);
    // team request is still fine even with missing evidence
    expect(violatesEvidenceTier("team", [], 2)).toBe(false);
  });

  it("does not constrain an opportunity with no item evidence (manual, external allowed)", () => {
    expect(violatesEvidenceTier("external", [], 0)).toBe(false);
    expect(violatesEvidenceTier("team", [], 0)).toBe(false);
  });
});
