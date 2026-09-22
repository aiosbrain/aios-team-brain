import { describe, expect, it } from "vitest";

import { filterArcFactsByAuthorizedItems } from "@/lib/graph/arc-input-authorization";
import type { AtomicFact } from "@/lib/graph/learning";

const fact = (id: string, episodes: string[], text = id): AtomicFact => ({
  id, fact: text, at: "2026-09-22T00:00:00Z", subjectType: "work", subject: "subject",
  object: "object", episodeUuids: episodes,
});

describe("arc synthesis source authorization", () => {
  it("requires every source of mixed text to be authorized, not one visible citation", () => {
    const facts = [fact("mixed", ["visible", "restricted"], "RESTRICTED-MIXED-MARKER")];
    const episodes = new Map([
      ["visible", { itemId: "visible-item" }],
      ["restricted", { itemId: "restricted-item" }],
    ]);
    expect(filterArcFactsByAuthorizedItems(facts, episodes, new Set(["visible-item"]))).toEqual([]);
    expect(filterArcFactsByAuthorizedItems(facts, episodes, new Set(["visible-item", "restricted-item"]))).toEqual(facts);
  });

  it("fails closed for missing or unresolved provenance", () => {
    const missing = fact("missing", []);
    const unresolved = fact("unresolved", ["unknown"]);
    expect(filterArcFactsByAuthorizedItems([missing, unresolved], new Map(), new Set(["anything"]))).toEqual([]);
  });
});
