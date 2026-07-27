import { describe, expect, it } from "vitest";
import { parseTaskFeedMode } from "@/app/api/v1/tasks/route";

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
