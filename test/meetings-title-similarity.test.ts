import { describe, expect, it } from "vitest";
import { titleSimilarity } from "@/lib/meetings/merge-format";
import { DEFAULT_TITLE_MERGE_THRESHOLD } from "@/lib/meetings/merge";

/**
 * MTGATT-1 / AIO-962 — the comparator that lets a calendar event fold into its own transcript.
 *
 * A calendar event has NO BODY by design, so `transcriptOverlap` cannot judge it and
 * `findDuplicateMeeting` used to skip it outright (`if (!item?.body) continue`). That is why a pushed
 * calendar event and the Granola transcript of the same meeting became two notes for one meeting.
 *
 * The titles here are the real prod pairs the feature has to handle, not invented ones.
 */
const BAR = DEFAULT_TITLE_MERGE_THRESHOLD;

describe("titleSimilarity — merges the same meeting, not merely similar-sounding ones", () => {
  it("merges when one producer's title extends the other's — the real shape", () => {
    // Google keeps the invite subject; Granola derives its own and appends.
    const s = titleSimilarity(
      "Stephan & John — DSM-Firmenich Demo Prep",
      "Stephan & John — DSM-Firmenich Demo Prep + AIOS"
    );
    expect(s).toBeGreaterThanOrEqual(BAR);
  });

  it("merges across punctuation and case differences", () => {
    expect(titleSimilarity("Onboarding Stephan on AIOS", "onboarding stephan / aios")).toBeGreaterThanOrEqual(BAR);
  });

  it("does NOT merge two different meetings that share only stopwords", () => {
    // The failure a naive shared-token rule produces: everything called "meeting" merges.
    expect(titleSimilarity("Meeting with John", "Meeting with Sarah")).toBeLessThan(BAR);
    expect(titleSimilarity("Weekly sync", "Daily standup")).toBeLessThan(BAR);
  });

  it("does NOT merge unrelated meetings on the same day", () => {
    expect(
      titleSimilarity("Content creation strategy session", "Pickle prototype quote and API integration")
    ).toBeLessThan(BAR);
  });

  it("scores 0 when either title has no significant tokens — absence of evidence, not identity", () => {
    // Two empty token sets are trivially 'equal'. Returning 1.0 there would merge every meeting
    // whose title is a single stopword.
    expect(titleSimilarity("Sync", "Chat")).toBe(0);
    expect(titleSimilarity("", "Content creation strategy session")).toBe(0);
    expect(titleSimilarity("   ", "")).toBe(0);
  });

  it("is symmetric — merge must not depend on which side arrived first", () => {
    const a = "Stephan & John — DSM-Firmenich Demo Prep";
    const b = "Stephan & John — DSM-Firmenich Demo Prep + AIOS";
    expect(titleSimilarity(a, b)).toBe(titleSimilarity(b, a));
  });

  it("an identical title scores 1", () => {
    expect(titleSimilarity("Content creation strategy session", "Content creation strategy session")).toBe(1);
  });
});
