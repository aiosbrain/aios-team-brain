import { describe, it, expect } from "vitest";
import { chunkContentLegacy, chunkContentUnderConfig } from "@/lib/graph/project";
import { episodeName, itemIdFromEpisodeName } from "@/lib/graph/episode-name";

/**
 * Chunking is the no-loss fix for Graphiti's extraction cap: a large item becomes several small
 * episodes instead of one truncated one, so all its content reaches the graph AND each episode stays
 * extractable. These specs pin the pure boundary behavior + the round-trippable naming.
 *
 * ⚠️ THE LEGACY ALGORITHM IS PINNED HERE, AND IT IS NOT DEAD CODE. PIPEFF-3 moved new chunking to
 * `cdc1` with a deliberately LAZY rollout: a row whose body has not changed keeps its `"<chars>x<cap>"`
 * chunking indefinitely, and the projector decides to leave it alone by RE-CHUNKING it under that
 * stored config and reproducing its stored hashes. So this function must stay byte-exact forever — a
 * drift of one character makes the whole legacy corpus fail completeness and full-re-push (~$76).
 * The assertions below are unchanged from the byte-offset era, on purpose.
 */
describe("chunkContentLegacy — byte-exact, forever", () => {
  it("keeps a normal item as a single chunk (unchanged from before)", () => {
    expect(chunkContentLegacy("a short note", 2500, 16)).toEqual(["a short note"]);
  });

  it("splits a large body into ≤ chunkChars pieces, preserving every character in order", () => {
    const body = "abcdefghij"; // 10 chars
    const chunks = chunkContentLegacy(body, 4, 16);
    expect(chunks).toEqual(["abcd", "efgh", "ij"]);
    expect(chunks.join("")).toBe(body); // no content lost
  });

  it("caps at maxChunks (runaway-size backstop) — content beyond is dropped, not truncated to one", () => {
    const body = "x".repeat(100);
    const chunks = chunkContentLegacy(body, 10, 3); // 10 chunks worth, capped at 3
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length === 10)).toBe(true);
  });

  it("empty / whitespace-only body → no chunks (nothing to extract)", () => {
    expect(chunkContentLegacy("", 2500, 16)).toEqual([]);
    expect(chunkContentLegacy("   \n\t ", 2500, 16)).toEqual([]);
  });

  it("is exactly what a stored legacy config re-chunks to — the completeness check's dependency", () => {
    // The property the lazy rollout rests on: dispatching on the stored string reproduces the same
    // bytes the legacy path produced. If these ever diverge, every legacy row full-re-pushes.
    const body = "abcdefghij";
    expect(chunkContentUnderConfig(body, "4x16")).toEqual(chunkContentLegacy(body, 4, 16));
    const long = "x".repeat(100);
    expect(chunkContentUnderConfig(long, "10x3")).toEqual(chunkContentLegacy(long, 10, 3));
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
