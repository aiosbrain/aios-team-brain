import { describe, expect, it } from "vitest";
import { episodeGroupId, visibleGroupIds } from "@/lib/graph/group";

describe("graph tier-scoped group ids", () => {
  it("encodes team + tier into the group id", () => {
    expect(episodeGroupId("acme", "team")).toBe("acme:team");
    expect(episodeGroupId("acme", "external")).toBe("acme:external");
  });

  it("a team viewer may search both tiers", () => {
    expect(visibleGroupIds("acme", "team").sort()).toEqual(["acme:external", "acme:team"]);
  });

  it("an external viewer may search ONLY the external group (no team leak)", () => {
    expect(visibleGroupIds("acme", "external")).toEqual(["acme:external"]);
  });
});
