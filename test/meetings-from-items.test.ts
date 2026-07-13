import { describe, expect, it } from "vitest";
import { isMeetingTranscript, deriveMeetingTitle, deriveOccurredAt } from "@/lib/meetings/from-items";

/**
 * Spec for the pure bits of the meeting-notes bridge: which transcripts count as meetings (Granola
 * yes, Slack threads NO — the whole point), and deriving a title + date from the item's shape.
 */

describe("isMeetingTranscript", () => {
  it("is true for recognized meeting sources", () => {
    expect(isMeetingTranscript("transcript", "granola")).toBe(true);
    expect(isMeetingTranscript("transcript", "Granola")).toBe(true); // case-insensitive
    expect(isMeetingTranscript("transcript", "zoom")).toBe(true);
    expect(isMeetingTranscript("transcript", "fireflies")).toBe(true);
  });

  it("is FALSE for slack threads (they're chat, not meetings)", () => {
    expect(isMeetingTranscript("transcript", "slack")).toBe(false);
  });

  it("is false for non-transcript kinds or missing/unknown source", () => {
    expect(isMeetingTranscript("deliverable", "granola")).toBe(false);
    expect(isMeetingTranscript("transcript", null)).toBe(false);
    expect(isMeetingTranscript("transcript", "notion")).toBe(false);
  });
});

describe("deriveMeetingTitle", () => {
  it("prefers the transcript's first markdown H1", () => {
    expect(deriveMeetingTitle("# John / Chetan AIOS\n\n> 2026-07-06\n", "2-work/transcripts/x.md")).toBe(
      "John / Chetan AIOS"
    );
  });

  it("falls back to the de-slugified filename, stripping a leading date", () => {
    expect(deriveMeetingTitle("no heading here", "2-work/transcripts/2026-07-06-john-chetan-aios.md")).toBe(
      "john chetan aios"
    );
  });

  it("falls back to 'Meeting' when there's nothing usable", () => {
    expect(deriveMeetingTitle("", "2026-07-06-.md")).toBe("Meeting");
  });
});

describe("deriveOccurredAt", () => {
  it("reads a date from frontmatter (created/source_ts/date)", () => {
    expect(deriveOccurredAt({ created: "2026-07-06" }, "x.md")).toBe("2026-07-06");
    expect(deriveOccurredAt({ source_ts: "2026-07-06T16:51:00Z" }, "x.md")).toBe("2026-07-06");
  });

  it("falls back to a date prefix on the filename", () => {
    expect(deriveOccurredAt({}, "transcripts/2026-07-06-john-chetan.md")).toBe("2026-07-06");
  });

  it("returns null when no date is present", () => {
    expect(deriveOccurredAt({ source: "granola" }, "transcripts/john-chetan.md")).toBeNull();
  });
});
