import { describe, expect, it } from "vitest";
import { nextCursorFor, parseTaskFeedMode, parseTaskKeys, unknownKeysFor } from "@/app/api/v1/tasks/route";

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

/**
 * brain-api 1.14 — the by-key lookup. `?all=1` returns the 500 STALEST rows with no cursor, so it
 * cannot answer "does this key exist": prod had `AIO-484` at rank 628 of 677. These pin the two
 * decisions that make the answer trustworthy — refuse the question when the mode would filter rows,
 * and never report a key list derived from a truncated read.
 */
describe("by-key lookup parsing", () => {
  it("is not a by-key request when `keys` is absent", () => {
    expect(parseTaskKeys(null, "writeback")).toBeNull();
    expect(parseTaskKeys(null, "table")).toBeNull();
  });

  it("REFUSES outside table mode — a filtered feed would call a real key missing", () => {
    for (const mode of ["writeback", "sync-origin"] as const) {
      const parsed = parseTaskKeys("AIO-1", mode);
      expect(parsed && "error" in parsed, `${mode} must be refused`).toBe(true);
    }
    expect(parseTaskKeys("AIO-1", "table")).toEqual({ keys: ["AIO-1"] });
  });

  it("collapses duplicates and blanks", () => {
    expect(parseTaskKeys("AIO-1, ,AIO-1, AIO-2 ", "table")).toEqual({ keys: ["AIO-1", "AIO-2"] });
  });

  it("refuses an empty list and an over-long one", () => {
    expect(parseTaskKeys(",, ", "table")).toEqual({ error: expect.stringContaining("at least one") });
    const many = Array.from({ length: 201 }, (_, i) => `A-${i}`).join(",");
    expect(parseTaskKeys(many, "table")).toEqual({ error: expect.stringContaining("limited to 200") });
    const atCap = Array.from({ length: 200 }, (_, i) => `A-${i}`).join(",");
    expect(parseTaskKeys(atCap, "table")).toEqual({ keys: expect.any(Array) });
  });
});

describe("unknown_keys — an answer, or an admission, never a guess", () => {
  it("names exactly the requested keys that matched nothing", () => {
    expect(unknownKeysFor(["A", "B", "C"], [{ row_key: "B" }], false)).toEqual(["A", "C"]);
    expect(unknownKeysFor(["A"], [{ row_key: "A" }], false)).toEqual([]);
  });

  it("is NULL when the read was truncated — absence from a prefix proves nothing", () => {
    // The same rule the CI consumer applies, kept on the side that actually knows whether the
    // result was capped. A list here would be confidently wrong.
    expect(unknownKeysFor(["A"], [{ row_key: "B" }], true)).toBeNull();
  });

  it("ignores null row_keys rather than counting them as a match", () => {
    expect(unknownKeysFor(["A"], [{ row_key: null }], false)).toEqual(["A"]);
  });
});
