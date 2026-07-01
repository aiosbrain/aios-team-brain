import { describe, expect, it } from "vitest";
import { chunkText } from "@/lib/query/chunk";

/**
 * Spec for dense-index chunking: deterministic, bounded chunks with overlap, honoring boundaries.
 * Derived from what dense retrieval needs (each chunk embeddable + a fact spanning a boundary still
 * lands whole in some chunk), not from the implementation.
 */

describe("chunkText", () => {
  it("returns [] for empty/whitespace input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps a short doc as a single chunk", () => {
    expect(chunkText("a short note about the auth redesign")).toEqual([
      "a short note about the auth redesign",
    ]);
  });

  it("splits a long doc into multiple bounded chunks", () => {
    const para = "sentence about the topic. ".repeat(200); // ~5200 chars
    const chunks = chunkText(para, { maxChars: 500, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500 + 60); // soft cap + overlap seed
  });

  it("carries overlap so adjacent chunks share continuity", () => {
    const text = Array.from({ length: 40 }, (_, i) => `para ${i} with some body text here.`).join("\n\n");
    const chunks = chunkText(text, { maxChars: 300, overlap: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    // the start of chunk 2 should echo a tail token from chunk 1 (overlap seam)
    const tail1 = chunks[0].slice(-40);
    const head2 = chunks[1].slice(0, 40);
    const share = tail1.split(" ").some((w) => w.length > 2 && head2.includes(w));
    expect(share).toBe(true);
  });

  it("hard-splits a single token longer than maxChars", () => {
    const chunks = chunkText("x".repeat(1000), { maxChars: 300 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
  });
});
