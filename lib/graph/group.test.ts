import { describe, expect, it } from "vitest";
import { episodeGroupId, visibleGroupIds } from "@/lib/graph/group";

describe("graph tier-scoped group ids", () => {
  it("encodes team + tier into the group id", () => {
    expect(episodeGroupId("acme", "team")).toBe("acme_team");
    expect(episodeGroupId("acme", "external")).toBe("acme_external");
  });

  // Regression: Graphiti's validate_group_id rejects `:` — a colon separator raised
  // GroupIdValidationError and silently killed the ingest worker (verified live 2026-06-24).
  it("produces a Graphiti-valid group_id (only [A-Za-z0-9_-], no colon)", () => {
    for (const id of [episodeGroupId("acme-eng", "team"), episodeGroupId("acme-eng", "external")]) {
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(id).not.toContain(":");
    }
  });

  it("throws on a slug that would yield an invalid group_id", () => {
    expect(() => episodeGroupId("bad slug!", "team")).toThrow(/invalid Graphiti group_id/);
  });

  it("a team viewer may search both tiers", () => {
    expect(visibleGroupIds("acme", "team").sort()).toEqual(["acme_external", "acme_team"]);
  });

  it("an external viewer may search ONLY the external group (no team leak)", () => {
    expect(visibleGroupIds("acme", "external")).toEqual(["acme_external"]);
  });
});
