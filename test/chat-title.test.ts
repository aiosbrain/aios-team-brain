import { describe, it, expect } from "vitest";
import { cleanTitle } from "@/lib/chat/title";

// Spec: the LLM title output is sanitized to one clean line for the sidebar — strip quotes,
// reasoning spans, and trailing punctuation; collapse whitespace; cap length.

describe("cleanTitle", () => {
  it("strips surrounding quotes and trailing punctuation", () => {
    expect(cleanTitle('"Weekly Accomplishments Review."')).toBe("Weekly Accomplishments Review");
    expect(cleanTitle("  'Railway Deploy Incident'  ")).toBe("Railway Deploy Incident");
  });

  it("keeps only the first line", () => {
    expect(cleanTitle("Linear Importer Status\nignore this second line")).toBe("Linear Importer Status");
  });

  it("drops <think> reasoning spans from reasoning models", () => {
    expect(cleanTitle("<think>hmm what to call this</think>Chat History Design")).toBe("Chat History Design");
  });

  it("collapses whitespace and caps length", () => {
    expect(cleanTitle("A    B   C")).toBe("A B C");
    const long = "word ".repeat(40);
    expect(cleanTitle(long, 20).length).toBeLessThanOrEqual(20);
  });

  it("returns empty string for empty/garbage input (caller keeps the derived title)", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle('   ""   ')).toBe("");
  });
});
