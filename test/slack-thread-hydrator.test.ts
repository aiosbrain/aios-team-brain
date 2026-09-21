import { describe, expect, it } from "vitest";
import { validateSlackRepliesPage } from "@/lib/ingest/slack-thread-hydrator";

const ROOT = "1718900000.000100";
describe("inactive Slack thread hydrator pagination", () => {
  it("retains the raw root and accepts a terminal replies page", () => {
    expect(validateSlackRepliesPage({ messages: [{ ts: ROOT, text: "root" }, { ts: "1718900001.000200" }], hasMore: false, nextCursor: null }, ROOT, null))
      .toMatchObject({ ok: true, terminal: true });
  });
  it("refuses missing roots, incomplete pagination, and repeated cursors without advancing", () => {
    expect(validateSlackRepliesPage({ messages: [{ ts: "1718900001.000200" }], hasMore: false, nextCursor: null }, ROOT, null)).toEqual({ ok: false, category: "missing_root" });
    expect(validateSlackRepliesPage({ messages: [{ ts: ROOT }], hasMore: true, nextCursor: null }, ROOT, null)).toEqual({ ok: false, category: "pagination_incomplete" });
    expect(validateSlackRepliesPage({ messages: [{ ts: ROOT }], hasMore: true, nextCursor: "again" }, ROOT, "again")).toEqual({ ok: false, category: "cursor_repeated" });
  });
  it("refuses a page that offers a continuation cursor while saying, or omitting, that there is no more", () => {
    // AIO-1170 fix-review FX-01: the sibling of the history-pager fix (P4-03). `hasMore` false with a live cursor is
    // a contradiction; taken as terminal it stages the thread as COMPLETE and checkpoints its cursor to null, so a
    // truncated conversation is what the future publisher would publish as the whole thread.
    expect(validateSlackRepliesPage({ messages: [{ ts: ROOT }], hasMore: false, nextCursor: "page-2" }, ROOT, null))
      .toEqual({ ok: false, category: "pagination_incomplete" });
    expect(validateSlackRepliesPage({ messages: [{ ts: "1718900001.000200" }], hasMore: false, nextCursor: "page-4" }, ROOT, "page-3"))
      .toEqual({ ok: false, category: "pagination_incomplete" });
  });
  it("accepts a rootless continuation, including a terminal empty page, without inventing a root", () => {
    expect(validateSlackRepliesPage({ messages: [{ ts: "1718900001.000200" }, { ts: "1718900001.000200" }], hasMore: true, nextCursor: "page-3" }, ROOT, "page-2"))
      .toMatchObject({ ok: true, terminal: false, nextCursor: "page-3" });
    expect(validateSlackRepliesPage({ messages: [], hasMore: false, nextCursor: null }, ROOT, "page-3"))
      .toMatchObject({ ok: true, terminal: true, nextCursor: null });
    expect(validateSlackRepliesPage({ messages: [], hasMore: false, nextCursor: null }, ROOT, null))
      .toEqual({ ok: false, category: "missing_root" });
  });
  it("rejects malformed messages and cursors before staging a continuation", () => {
    expect(validateSlackRepliesPage({ messages: [null as never], hasMore: false, nextCursor: null }, ROOT, "page-2"))
      .toEqual({ ok: false, category: "malformed_page" });
    expect(validateSlackRepliesPage({ messages: [{ ts: "1718900001.000200" }], hasMore: true, nextCursor: "  " }, ROOT, "page-2"))
      .toEqual({ ok: false, category: "pagination_incomplete" });
    expect(validateSlackRepliesPage({ messages: [{ ts: "1718900001.000200" }], hasMore: true, nextCursor: "x".repeat(1025) }, ROOT, "page-2"))
      .toEqual({ ok: false, category: "malformed_page" });
    expect(validateSlackRepliesPage({ messages: [{ ts: "1718900001.000200" }], hasMore: true, nextCursor: "page-2" }, ROOT, "page-3", ["page-2", "page-3"]))
      .toEqual({ ok: false, category: "cursor_repeated" });
    expect(validateSlackRepliesPage({ messages: [{ ts: "1718900001.000200" }], hasMore: true, nextCursor: "bad\ncursor" }, ROOT, "page-2"))
      .toEqual({ ok: false, category: "malformed_page" });
  });
});
