import { describe, it, expect } from "vitest";
import { resolvePositiveInt, pickEpisodeTimestamp } from "@/lib/graph/project";

/**
 * Two silent-corruption landmines in the projector, both flagged by review:
 *  - a malformed `GRAPH_CHUNK_CHARS`/`GRAPH_MAX_EPISODE_CHUNKS` env would make `chunkContent` emit
 *    empty-content episodes (chunk size 0/NaN) or none at all (chunk cap 0/NaN) — the projector
 *    "succeeds" while feeding the graph nothing or garbage;
 *  - a present-but-garbage `source_ts` would fall through to now(), stamping an old doc "today" and
 *    floating it to the top of the recency-ranked arcs.
 */
describe("resolvePositiveInt — malformed size/cap env can't break projection", () => {
  it("falls back on empty / non-numeric / zero / negative / fractional<1 / nullish", () => {
    // `0.5` is the sneaky one: finite and >0, but Math.floor → 0 (a 0 chunk size blanks episodes).
    for (const bad of ["", "abc", "0", "-100", "  ", "0.5", "0.9", undefined, null, "NaN"]) {
      expect(resolvePositiveInt(bad, 2500)).toBe(2500);
      expect(resolvePositiveInt(bad, 16)).toBe(16);
    }
  });

  it("honors a finite positive override (floored to an integer)", () => {
    expect(resolvePositiveInt("6000", 2500)).toBe(6000);
    expect(resolvePositiveInt("500", 2500)).toBe(500);
    expect(resolvePositiveInt("2500.9", 2500)).toBe(2500); // floored, still ≥1
    expect(resolvePositiveInt("16", 16)).toBe(16);
  });
});

describe("pickEpisodeTimestamp — a bad source_ts falls back to synced_at, not now()", () => {
  const syncedAt = "2026-07-09T10:39:17.281Z";

  it("uses a valid source_ts when present", () => {
    expect(pickEpisodeTimestamp("2024-01-02T03:04:05Z", syncedAt)).toBe("2024-01-02T03:04:05Z");
  });

  it("falls back to synced_at for a present-but-unparseable source_ts (never now())", () => {
    for (const garbage of ["not a date", "", "13/45/2026", "??? "]) {
      expect(pickEpisodeTimestamp(garbage, syncedAt)).toBe(syncedAt);
    }
  });

  it("uses synced_at when source_ts is absent / non-string", () => {
    for (const absent of [undefined, null, 12345, {}]) {
      expect(pickEpisodeTimestamp(absent, syncedAt)).toBe(syncedAt);
    }
  });
});
