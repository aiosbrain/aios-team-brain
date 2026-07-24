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

describe("pickEpisodeTimestamp — the item's work-time, else synced_at (never now())", () => {
  const syncedAt = "2026-07-09T10:39:17.281Z";

  it("uses a valid source_ts when present (ISO-normalized)", () => {
    expect(pickEpisodeTimestamp({ source_ts: "2024-01-02T03:04:05Z" }, syncedAt)).toBe(
      "2024-01-02T03:04:05.000Z"
    );
  });

  it("dates a git commit by committed_at — NOT synced_at (the graph/timeline disagreement)", () => {
    // Commits carry `committed_at`, never `source_ts`. Reading source_ts ALONE stamped every commit
    // of a freshly-linked repo with sync-time, so months-old work narrated as this week's storyline
    // while the timeline (which reads committed_at) dated the very same commits correctly.
    expect(pickEpisodeTimestamp({ committed_at: "2026-05-02T08:00:00Z" }, syncedAt)).toBe(
      "2026-05-02T08:00:00.000Z"
    );
  });

  it("dates a document by its own edit time, however the source spells it", () => {
    expect(pickEpisodeTimestamp({ last_edited_time: "2026-06-01T00:00:00Z" }, syncedAt)).toBe(
      "2026-06-01T00:00:00.000Z"
    );
    expect(pickEpisodeTimestamp({ modifiedTime: "2026-06-02T00:00:00Z" }, syncedAt)).toBe(
      "2026-06-02T00:00:00.000Z"
    );
  });

  it("falls back to synced_at for a present-but-unparseable work-time (never now())", () => {
    for (const garbage of ["not a date", "", "13/45/2026", "??? "]) {
      expect(pickEpisodeTimestamp({ source_ts: garbage }, syncedAt)).toBe(syncedAt);
    }
  });

  it("uses synced_at when the work-time is absent / non-string", () => {
    for (const absent of [undefined, null, 12345, {}]) {
      expect(pickEpisodeTimestamp({ source_ts: absent }, syncedAt)).toBe(syncedAt);
    }
    expect(pickEpisodeTimestamp({}, syncedAt)).toBe(syncedAt);
    expect(pickEpisodeTimestamp(null, syncedAt)).toBe(syncedAt);
  });
});
