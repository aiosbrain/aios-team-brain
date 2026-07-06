import { describe, expect, it } from "vitest";
import { pickHomeState } from "./home-state";

describe("pickHomeState", () => {
  it("admin-bootstrap: admin on a team with nothing synced yet, regardless of their own key", () => {
    expect(pickHomeState({ isAdmin: true, itemCount: 0, hasOwnKey: false })).toBe("admin-bootstrap");
    expect(pickHomeState({ isAdmin: true, itemCount: 0, hasOwnKey: true })).toBe("admin-bootstrap");
  });

  it("member-setup: a non-admin who has never issued their own key, even on an already-active team", () => {
    expect(pickHomeState({ isAdmin: false, itemCount: 0, hasOwnKey: false })).toBe("member-setup");
    expect(pickHomeState({ isAdmin: false, itemCount: 42, hasOwnKey: false })).toBe("member-setup");
  });

  it("dashboard: everyone else", () => {
    expect(pickHomeState({ isAdmin: false, itemCount: 42, hasOwnKey: true })).toBe("dashboard");
    expect(pickHomeState({ isAdmin: false, itemCount: 0, hasOwnKey: true })).toBe("dashboard");
    expect(pickHomeState({ isAdmin: true, itemCount: 42, hasOwnKey: false })).toBe("dashboard");
    expect(pickHomeState({ isAdmin: true, itemCount: 42, hasOwnKey: true })).toBe("dashboard");
  });
});
