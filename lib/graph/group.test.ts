import { describe, expect, it } from "vitest";
import { episodeGroupId } from "@/lib/graph/group";

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

  // The tier-fence assertions that used to live here ("a team viewer sees both, an external viewer
  // sees ONLY external") moved to lib/graph/tier-groups.test.ts with `visibleGroupIds` itself: the
  // read set is resolved from the built-ins' stored pointers now, not recomputed from the live
  // slug, because a slug rename made the reader and the projector name different groups.
});
