import { describe, expect, it } from "vitest";
import { isRestrictedTier, canSeeAccess } from "@/lib/auth/visibility";

/**
 * Fail-CLOSED tier semantics (audit #275 hardening). There is NO RLS, so every tier-scoped read is
 * sole-enforced in app code. The invariant: ONLY `team` is unrestricted; `external` today AND any
 * future/unknown tier the enum might grow (e.g. `admin`) or a bad cast might smuggle in must be
 * treated as restricted. These assertions pin that a NON-team value never falls through to the
 * unfiltered path — the fail-OPEN `tier === "external"` idiom this replaced would.
 */
describe("isRestrictedTier — only team is unrestricted (fail closed)", () => {
  it("team is NOT restricted", () => {
    expect(isRestrictedTier("team")).toBe(false);
  });

  it("external is restricted", () => {
    expect(isRestrictedTier("external")).toBe(true);
  });

  it("an unknown / future / malformed tier is restricted (the whole point)", () => {
    for (const t of ["admin", "client", "private", "", "TEAM", " team", "unknown"]) {
      expect(isRestrictedTier(t)).toBe(true);
    }
  });
});

describe("canSeeAccess — the single-item mirror of the same rule", () => {
  it("team sees any access; a non-team tier sees only external", () => {
    expect(canSeeAccess("team", "team")).toBe(true);
    expect(canSeeAccess("team", "external")).toBe(true);
    expect(canSeeAccess("external", "team")).toBe(false);
    expect(canSeeAccess("external", "external")).toBe(true);
    // an unknown viewer tier is restricted to external content only
    expect(canSeeAccess("admin" as unknown as "team" | "external", "team")).toBe(false);
    expect(canSeeAccess("admin" as unknown as "team" | "external", "external")).toBe(true);
  });
});
