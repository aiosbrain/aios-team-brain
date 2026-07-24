import { describe, expect, it } from "vitest";
import { canAccessAdmin } from "@/lib/auth/admin-access";

/**
 * Spec: the /admin subtree requires an admin role AND an unrestricted (team) tier. role and tier are
 * independent DB columns with no coupling constraint, so an external-tier admin is representable — and
 * with no RLS backstop it would otherwise expose the whole internal admin surface to a client. The
 * gate fails CLOSED on any non-team tier or missing field.
 */
describe("canAccessAdmin", () => {
  it("allows a team-tier admin", () => {
    expect(canAccessAdmin({ role: "admin", tier: "team" })).toBe(true);
  });

  it("DENIES an external-tier admin (the leak this closes)", () => {
    expect(canAccessAdmin({ role: "admin", tier: "external" })).toBe(false);
  });

  it("denies a team-tier non-admin", () => {
    expect(canAccessAdmin({ role: "member", tier: "team" })).toBe(false);
    expect(canAccessAdmin({ role: "lead", tier: "team" })).toBe(false);
  });

  it("fails closed on a missing or unknown tier", () => {
    expect(canAccessAdmin({ role: "admin" })).toBe(false);
    expect(canAccessAdmin({ role: "admin", tier: null })).toBe(false);
    expect(canAccessAdmin({ role: "admin", tier: "future_unknown_tier" })).toBe(false);
  });

  it("denies an empty / null member", () => {
    expect(canAccessAdmin({})).toBe(false);
    expect(canAccessAdmin({ role: null, tier: null })).toBe(false);
  });
});
