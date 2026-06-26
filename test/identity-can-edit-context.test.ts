import { describe, expect, it } from "vitest";
import { canEditMemberContext } from "@/lib/identity/context";

/**
 * Spec for the edit authorization boundary (the gate behind the People-page context editor):
 * only the member themselves or an admin may write a member's context. A teammate must NOT be
 * able to edit someone else's profile/goals/time-off. Derived from the product rule, not the impl.
 */

const SELF = "m-self";
const OTHER = "m-other";

describe("canEditMemberContext", () => {
  it("a member may edit their OWN context", () => {
    expect(canEditMemberContext({ id: SELF, role: "member" }, SELF)).toBe(true);
  });

  it("a non-admin member may NOT edit a teammate's context", () => {
    expect(canEditMemberContext({ id: SELF, role: "member" }, OTHER)).toBe(false);
    expect(canEditMemberContext({ id: SELF, role: "lead" }, OTHER)).toBe(false);
  });

  it("an admin may edit anyone's context", () => {
    expect(canEditMemberContext({ id: SELF, role: "admin" }, OTHER)).toBe(true);
  });
});
