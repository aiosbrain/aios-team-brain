import { describe, expect, it } from "vitest";
import { nextCursorFor, parseTaskFeedMode } from "@/app/api/v1/tasks/route";

/**
 * brain-api 1.13 (AIO-537). The mode selector must keep every pre-1.13 request shape mapping to
 * exactly the response it got before, and must FAIL a typo rather than silently answering with
 * the writeback feed (a client that thinks it asked for the return leg would merge nothing and
 * report success).
 */
describe("task feed mode parsing", () => {
  it("keeps the pre-1.13 defaults", () => {
    expect(parseTaskFeedMode(null, null)).toBe("writeback");
    expect(parseTaskFeedMode(null, "1")).toBe("table");
    expect(parseTaskFeedMode(null, "0")).toBe("writeback");
    expect(parseTaskFeedMode("", null)).toBe("writeback");
  });

  it("accepts the explicit modes", () => {
    expect(parseTaskFeedMode("writeback", null)).toBe("writeback");
    expect(parseTaskFeedMode("table", null)).toBe("table");
    expect(parseTaskFeedMode("sync-origin", null)).toBe("sync-origin");
  });

  it("rejects anything else", () => {
    expect(parseTaskFeedMode("sync_origin", null)).toBeNull();
    expect(parseTaskFeedMode("SYNC-ORIGIN", null)).toBeNull();
    expect(parseTaskFeedMode("all", "1")).toBeNull();
  });
});

/**
 * A full page is indistinguishable from a truncation, and the client advances its cursor after a
 * successful merge — without a cursor the 501st+ changed row would be skipped forever (the first
 * pull runs from EPOCH over a whole project, so this is reachable, not theoretical).
 */
describe("sync-origin pagination cursor", () => {
  const page = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      updated_at: `2026-07-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));

  it("returns the last row's updated_at when the page is full", () => {
    const rows = page(500);
    expect(nextCursorFor("sync-origin", rows)).toBe(
      new Date(rows[499].updated_at).toISOString(),
    );
  });

  it("returns null when the page is short (nothing left to drain)", () => {
    expect(nextCursorFor("sync-origin", page(499))).toBeNull();
    expect(nextCursorFor("sync-origin", [])).toBeNull();
  });

  it("never pages the pre-1.13 modes", () => {
    expect(nextCursorFor("writeback", page(500))).toBeNull();
    expect(nextCursorFor("table", page(500))).toBeNull();
  });
});
