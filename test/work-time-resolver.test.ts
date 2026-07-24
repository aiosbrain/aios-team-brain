import { describe, expect, it } from "vitest";
import { resolveWorkTime } from "@/lib/ingest/work-time";

/**
 * Spec for the ONE work-time resolver shared by the timeline and the graph projector. Derived from
 * the contract ("when did this work happen"), not the implementation.
 *
 * Two properties matter beyond "it parses a date":
 *  • PRIORITY — an explicit source timestamp beats an edit time beats a creation time, so a doc
 *    edited today isn't filed under the day it was created a year ago.
 *  • SPELLING TOLERANCE — sources we don't control spell it differently; an exact-match list
 *    silently resolved null and the timeline DROPPED those items. The resolver has a fast path for
 *    our own spellings and a normalized fallback for everyone else; both must agree.
 */

describe("resolveWorkTime", () => {
  it("prefers an explicit source timestamp over edit/creation times", () => {
    expect(
      resolveWorkTime({
        committed_at: "2026-07-01T00:00:00Z",
        source_ts: "2026-06-01T00:00:00Z",
        last_edited_time: "2026-05-01T00:00:00Z",
        created: "2026-01-01T00:00:00Z",
      })
    ).toBe("2026-07-01T00:00:00.000Z");
  });

  it("prefers an edit time over a creation time", () => {
    expect(
      resolveWorkTime({ created: "2026-01-01T00:00:00Z", last_edited_time: "2026-06-04T00:00:00Z" })
    ).toBe("2026-06-04T00:00:00.000Z");
  });

  it("falls back to a creation time when the doc was never edited", () => {
    expect(resolveWorkTime({ created_time: "2026-02-02T00:00:00Z" })).toBe("2026-02-02T00:00:00.000Z");
  });

  it("resolves the same instant regardless of how the source spells the key", () => {
    const want = "2026-06-10T08:30:00.000Z";
    for (const key of [
      "last_edited_time", // Notion
      "lastEditedTime",
      "modifiedTime", // Drive
      "modified at", // Drive, human-spelled
      "Modified At",
      "updated_at",
      "updated",
    ]) {
      expect(resolveWorkTime({ [key]: "2026-06-10T08:30:00Z" }), key).toBe(want);
    }
  });

  it("the fast path (our own spellings) and the normalized fallback agree", () => {
    // `committed_at` hits the direct-lookup fast path; `committedAt` only matches after
    // normalization. Both must yield the same instant, or the two paths have drifted.
    expect(resolveWorkTime({ committed_at: "2026-06-11T00:00:00Z" })).toBe(
      resolveWorkTime({ committedAt: "2026-06-11T00:00:00Z" })
    );
  });

  it("skips a present-but-unparseable value and keeps looking", () => {
    expect(resolveWorkTime({ committed_at: "not a date", source_ts: "2026-06-12T00:00:00Z" })).toBe(
      "2026-06-12T00:00:00.000Z"
    );
  });

  it("refuses a bare number — an ambiguous epoch must not silently mis-date work", () => {
    expect(resolveWorkTime({ source_ts: 1719878400 })).toBeNull();
    expect(resolveWorkTime({ source_ts: 1719878400000 })).toBeNull();
  });

  it("returns null when there is no work-time at all (caller decides: drop vs fall back)", () => {
    expect(resolveWorkTime({ source: "notion", title: "Undated doc" })).toBeNull();
    expect(resolveWorkTime({})).toBeNull();
    expect(resolveWorkTime(null)).toBeNull();
    expect(resolveWorkTime(undefined)).toBeNull();
  });

  it("never treats synced_at as work-time (it is bumped on every re-scan)", () => {
    // The whole point: a re-sync must not resurface old content as today's work.
    expect(resolveWorkTime({ synced_at: "2026-07-20T00:00:00Z" })).toBeNull();
  });
});
