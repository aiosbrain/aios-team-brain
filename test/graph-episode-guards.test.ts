import { describe, it, expect } from "vitest";
import { resolveMaxEpisodeChars, pickEpisodeTimestamp } from "@/lib/graph/project";

/**
 * Two silent-corruption landmines in the projector, both flagged by review:
 *  - a malformed `GRAPH_MAX_EPISODE_CHARS` env would slice every episode to "" (projector "succeeds"
 *    while feeding the graph nothing);
 *  - a present-but-garbage `source_ts` would fall through to now(), stamping an old doc "today" and
 *    floating it to the top of the recency-ranked arcs.
 */
describe("resolveMaxEpisodeChars — malformed env can't blank projection", () => {
  it("falls back to 4000 on empty / non-numeric / zero / negative / nullish", () => {
    for (const bad of ["", "abc", "0", "-100", "  ", undefined, null, "NaN"]) {
      expect(resolveMaxEpisodeChars(bad)).toBe(4000);
    }
  });

  it("honors a finite positive override", () => {
    expect(resolveMaxEpisodeChars("6000")).toBe(6000);
    expect(resolveMaxEpisodeChars("500")).toBe(500);
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
