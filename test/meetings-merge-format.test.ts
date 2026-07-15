import { describe, expect, it } from "vitest";
import { transcriptOverlap, mergeTranscripts } from "@/lib/meetings/merge-format";

/**
 * Spec for duplicate-meeting detection + merge. Derived from the scenario: two people upload the
 * same meeting; one may have transcribed less. Overlap must stay HIGH when one is a partial subset,
 * LOW for unrelated meetings; merge must union unique content without doubling near-duplicates.
 */
const A =
  "Chetan and John discussed the mission control dashboard. They agreed to leverage gbrain and Hermes. " +
  "John will configure the personal setup for genetic projects. They reviewed the task management approach.";
const APartial = "They agreed to leverage gbrain and Hermes. John will configure the personal setup for genetic projects.";
const Different = "Alice and Bob planned the Q3 marketing campaign budget and the launch timeline for the new mobile app.";

describe("transcriptOverlap", () => {
  it("scores a partial subset high (one person transcribed less)", () => {
    expect(transcriptOverlap(A, APartial)).toBeGreaterThan(0.8);
  });
  it("scores an unrelated meeting low", () => {
    expect(transcriptOverlap(A, Different)).toBeLessThan(0.2);
  });
  it("returns 0 when either side is empty", () => {
    expect(transcriptOverlap(A, "")).toBe(0);
  });
});

describe("mergeTranscripts", () => {
  it("keeps the longer base and appends the other's unique lines", () => {
    const merged = mergeTranscripts("line one\nline two\nline three", "line two\nline four");
    expect(merged).toContain("line one");
    expect(merged).toContain("line three");
    expect(merged).toContain("line four"); // unique to the second
    expect(merged.match(/line two/g)?.length).toBe(1); // not doubled
  });
  it("returns the base unchanged when the other adds nothing new", () => {
    const base = "a\nb\nc";
    expect(mergeTranscripts(base, "b\nc")).toBe(base);
  });
});
