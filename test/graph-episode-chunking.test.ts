import { describe, it, expect } from "vitest";
import { chunkContent } from "@/lib/graph/project";
import { episodeName, itemIdFromEpisodeName } from "@/lib/graph/episode-name";

/**
 * Chunking is the no-loss fix for Graphiti's extraction cap: a large item becomes several small
 * episodes instead of one truncated one, so all its content reaches the graph AND each episode stays
 * extractable. These specs pin the pure boundary behavior + the round-trippable naming.
 */
describe("chunkContent", () => {
  it("keeps a normal item as a single chunk (unchanged from before)", () => {
    expect(chunkContent("a short note", 2500, 16)).toEqual(["a short note"]);
  });

  it("splits a large body into ≤ chunkChars pieces, preserving every character in order", () => {
    const body = "abcdefghij"; // 10 chars
    const chunks = chunkContent(body, 4, 16);
    expect(chunks).toEqual(["abcd", "efgh", "ij"]);
    expect(chunks.join("")).toBe(body); // no content lost
  });

  it("caps at maxChunks (runaway-size backstop) — content beyond is dropped, not truncated to one", () => {
    const body = "x".repeat(100);
    const chunks = chunkContent(body, 10, 3); // 10 chunks worth, capped at 3
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length === 10)).toBe(true);
  });

  it("empty / whitespace-only body → no chunks (nothing to extract)", () => {
    expect(chunkContent("", 2500, 16)).toEqual([]);
    expect(chunkContent("   \n\t ", 2500, 16)).toEqual([]);
  });
});

describe("episodeName / itemIdFromEpisodeName — round-trip", () => {
  it("single-chunk item keeps the plain name (backward-compatible)", () => {
    expect(episodeName("abc", 0, 1)).toBe("items:abc");
    expect(itemIdFromEpisodeName("items:abc")).toBe("abc");
  });

  it("multi-chunk item uses the #k suffix, and every chunk resolves back to the same item", () => {
    expect(episodeName("abc", 0, 3)).toBe("items:abc#0");
    expect(episodeName("abc", 2, 3)).toBe("items:abc#2");
    expect(itemIdFromEpisodeName("items:abc#0")).toBe("abc");
    expect(itemIdFromEpisodeName("items:abc#2")).toBe("abc");
  });

  it("returns undefined for non-item episodes (e.g. correction writeback) and junk", () => {
    expect(itemIdFromEpisodeName("correction:arc-123")).toBeUndefined();
    expect(itemIdFromEpisodeName(null)).toBeUndefined();
    expect(itemIdFromEpisodeName("")).toBeUndefined();
  });
});
