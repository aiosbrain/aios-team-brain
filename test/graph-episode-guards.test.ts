import { describe, it, expect } from "vitest";
import { resolvePositiveInt, pickEpisodeTimestamp } from "@/lib/graph/project";
import { resolvePersistedWorkTime } from "@/lib/ingest/work-time";

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

describe("resolvePersistedWorkTime — the work-time we STORE, never sync-time", () => {
  // The frontmatter derivation moved OFF the projector: it now runs once at ingest and is written to
  // `items.work_at`, so every surface reads one stored answer instead of re-deriving (Pass-1 R1). These
  // cases moved with it — they are still the contract, just at the layer that now owns it.
  const firstSeen = "2026-07-09T10:39:17.281Z";

  it("uses a valid source_ts when present (ISO-normalized), and marks it source-dated", () => {
    expect(resolvePersistedWorkTime({ source_ts: "2024-01-02T03:04:05Z" }, firstSeen)).toEqual({
      workAt: "2024-01-02T03:04:05.000Z",
      fromSource: true,
    });
  });

  it("dates a git commit by committed_at — NOT sync time (the graph/timeline disagreement)", () => {
    // Commits carry `committed_at`, never `source_ts`. Reading source_ts ALONE stamped every commit
    // of a freshly-linked repo with sync-time, so months-old work narrated as this week's storyline
    // while the timeline (which reads committed_at) dated the very same commits correctly.
    expect(resolvePersistedWorkTime({ committed_at: "2026-05-02T08:00:00Z" }, firstSeen).workAt).toBe(
      "2026-05-02T08:00:00.000Z"
    );
  });

  it("dates a document by its own edit time, however the source spells it", () => {
    expect(resolvePersistedWorkTime({ last_edited_time: "2026-06-01T00:00:00Z" }, firstSeen).workAt).toBe(
      "2026-06-01T00:00:00.000Z"
    );
    expect(resolvePersistedWorkTime({ modifiedTime: "2026-06-02T00:00:00Z" }, firstSeen).workAt).toBe(
      "2026-06-02T00:00:00.000Z"
    );
  });

  it("falls back to FIRST-SEEN — never now(), never sync-time — when the source dates nothing usable", () => {
    // First-seen (`items.created_at`) is set once on insert. That is the whole point: `synced_at` is
    // bumped every tick, so a `synced_at` fallback re-dates undated work as today, forever.
    for (const garbage of ["not a date", "", "13/45/2026", "??? "]) {
      expect(resolvePersistedWorkTime({ source_ts: garbage }, firstSeen)).toEqual({
        workAt: firstSeen,
        fromSource: false,
      });
    }
    for (const absent of [undefined, null, 12345, {}]) {
      expect(resolvePersistedWorkTime({ source_ts: absent }, firstSeen).workAt).toBe(firstSeen);
    }
    expect(resolvePersistedWorkTime({}, firstSeen).workAt).toBe(firstSeen);
    expect(resolvePersistedWorkTime(null, firstSeen).workAt).toBe(firstSeen);
  });
});

describe("pickEpisodeTimestamp — reads the STORED work-time, doesn't re-derive", () => {
  it("uses the item's persisted work_at, whatever the adapter hands back", () => {
    const synced = "2026-07-09T10:39:17.281Z";
    expect(pickEpisodeTimestamp({ work_at: "2026-05-02T08:00:00Z", synced_at: synced })).toBe(
      "2026-05-02T08:00:00.000Z"
    );
    // the pg adapter returns timestamptz as a Date
    expect(pickEpisodeTimestamp({ work_at: new Date("2026-05-02T08:00:00Z"), synced_at: synced })).toBe(
      "2026-05-02T08:00:00.000Z"
    );
  });

  it("falls back to synced_at only for a row written before the column existed", () => {
    const synced = "2026-07-09T10:39:17.281Z";
    for (const missing of [null, undefined, "" as unknown as string]) {
      expect(pickEpisodeTimestamp({ work_at: missing, synced_at: synced })).toBe(synced);
    }
    expect(pickEpisodeTimestamp({ work_at: "garbage", synced_at: synced })).toBe(synced);
  });
});
