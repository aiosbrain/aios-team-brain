import { describe, expect, it } from "vitest";
import { extractWorkKeys } from "@/lib/pm-sync/work-keys";

describe("extractWorkKeys", () => {
  it("finds AIOS backlog keys in titles, bodies, and branches", () => {
    expect(
      extractWorkKeys({
        title: "W1.2.1 Add per-member cost aggregation",
        body: "AIOS-Work: P0\nAlso closes ENG-123.",
        branch: "feature/W2.4-plane-sync",
      })
    ).toEqual(["W1.2.1", "P0", "ENG-123", "W2.4"]);
  });

  it("deduplicates repeated keys", () => {
    expect(extractWorkKeys({ title: "P0 P0", body: "AIOS-Work: P0" })).toEqual(["P0"]);
  });
});
