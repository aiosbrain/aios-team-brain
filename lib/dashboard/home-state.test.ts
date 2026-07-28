import { describe, expect, it } from "vitest";
import { pickHomeState } from "./home-state";

describe("pickHomeState", () => {
  it("admin-bootstrap: admin on a team with nothing synced yet, regardless of connection", () => {
    expect(pickHomeState({ isAdmin: true, itemCount: 0, hasConnectedKey: false })).toBe("admin-bootstrap");
    expect(pickHomeState({ isAdmin: true, itemCount: 0, hasConnectedKey: true })).toBe("admin-bootstrap");
  });

  it("member-setup: anyone whose workstation has not authenticated, even on an active team", () => {
    expect(pickHomeState({ isAdmin: false, itemCount: 0, hasConnectedKey: false })).toBe("member-setup");
    expect(pickHomeState({ isAdmin: false, itemCount: 42, hasConnectedKey: false })).toBe("member-setup");
    expect(pickHomeState({ isAdmin: true, itemCount: 42, hasConnectedKey: false })).toBe("member-setup");
  });

  it("dashboard: a validated connection unlocks the normal dashboard", () => {
    expect(pickHomeState({ isAdmin: false, itemCount: 42, hasConnectedKey: true })).toBe("dashboard");
    expect(pickHomeState({ isAdmin: false, itemCount: 0, hasConnectedKey: true })).toBe("dashboard");
    expect(pickHomeState({ isAdmin: true, itemCount: 42, hasConnectedKey: true })).toBe("dashboard");
  });
});
