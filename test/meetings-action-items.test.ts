import { describe, expect, it, vi, beforeEach } from "vitest";

// Spec: extractActionItems is LLM-first with a deterministic markdown-scanner fallback. We stub the
// shared LLM transport (callMeetingsLLM) so the parse/validation/dedup/fallback behavior is tested
// without a live model — the whole point is that it degrades to the regex scanner, never throws.
vi.mock("@/lib/meetings/llm-extract", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, callMeetingsLLM: vi.fn() };
});

import { extractActionItems } from "@/lib/meetings/action-items";
import { callMeetingsLLM } from "@/lib/meetings/llm-extract";

const mockLLM = callMeetingsLLM as unknown as ReturnType<typeof vi.fn>;
const roster = [{ id: "m1", displayName: "Alex Rivera" }];

beforeEach(() => mockLLM.mockReset());

describe("extractActionItems", () => {
  it("parses LLM action items, keeping a valid due and nulling an invalid one", async () => {
    mockLLM.mockResolvedValue(
      JSON.stringify({
        actionItems: [
          { title: "Send the deck", assignee: "Alex Rivera", due: "2026-08-01" },
          { title: "Book the venue", assignee: "", due: "next week" },
        ],
      })
    );
    const items = await extractActionItems("(transcript)", roster, {});
    expect(items).toEqual([
      { title: "Send the deck", assignee: "Alex Rivera", due: "2026-08-01", line: 1, sourceText: "Send the deck" },
      { title: "Book the venue", assignee: "", due: null, line: 2, sourceText: "Book the venue" },
    ]);
  });

  it("drops empty-title items and dedupes by title", async () => {
    mockLLM.mockResolvedValue(
      JSON.stringify({
        actionItems: [
          { title: "Ship it", assignee: "" },
          { title: "  ", assignee: "" },
          { title: "ship it", assignee: "" },
        ],
      })
    );
    const items = await extractActionItems("(transcript)", roster, {});
    expect(items.map((i) => i.title)).toEqual(["Ship it"]);
  });

  it("falls back to the markdown scanner when the LLM is unavailable", async () => {
    mockLLM.mockResolvedValue(null);
    const transcript = "Notes\n- [ ] Draft the RFC\n- [ ] @alex review the PR";
    const items = await extractActionItems(transcript, roster, {});
    expect(items.map((i) => i.title)).toContain("Draft the RFC");
    expect(items.some((i) => i.assignee === "alex")).toBe(true);
  });

  it("falls back to the markdown scanner when the LLM returns an empty list but todos exist", async () => {
    mockLLM.mockResolvedValue(JSON.stringify({ actionItems: [] }));
    const transcript = "- [ ] Follow up with finance";
    const items = await extractActionItems(transcript, roster, {});
    expect(items.map((i) => i.title)).toEqual(["Follow up with finance"]);
  });

  it("falls back when the LLM returns non-JSON", async () => {
    mockLLM.mockResolvedValue("sorry, I cannot help with that");
    const transcript = "- [ ] Renew the certs";
    const items = await extractActionItems(transcript, roster, {});
    expect(items.map((i) => i.title)).toEqual(["Renew the certs"]);
  });

  it("returns an empty list when neither the LLM nor the scanner find anything", async () => {
    mockLLM.mockResolvedValue(JSON.stringify({ actionItems: [] }));
    const items = await extractActionItems("just prose, no action items here", roster, {});
    expect(items).toEqual([]);
  });
});
