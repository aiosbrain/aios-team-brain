import { describe, expect, it } from "vitest";
import { groundingNote } from "@/lib/query/claude";

// Spec: when retrieval found no query-specific match, the answer layer is told so it abstains.
describe("groundingNote (stay-quiet)", () => {
  it("is empty when grounded (no behavior change)", () => {
    expect(groundingNote(true)).toBe("");
  });

  it("tells the model to abstain when retrieval found no strong match", () => {
    const n = groundingNote(false);
    expect(n).toContain("No documents specifically matched");
    expect(n).toContain("say you don't have that information");
  });
});
