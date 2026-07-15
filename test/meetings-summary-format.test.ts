import { describe, expect, it } from "vitest";
import { summaryBullets } from "@/lib/meetings/summary-format";

/**
 * Spec for the summary bullet parser: a bulleted summary renders as a list; a prose paragraph does
 * not (falls back to `[]`). Derived from the display intent, not the implementation.
 */
describe("summaryBullets", () => {
  it("parses a bulleted summary into stripped points", () => {
    const s = "- Discussed the mission-control dashboard\n- Decided to leverage gbrain + Hermes\n- Next: configure personal setups";
    expect(summaryBullets(s)).toEqual([
      "Discussed the mission-control dashboard",
      "Decided to leverage gbrain + Hermes",
      "Next: configure personal setups",
    ]);
  });

  it("accepts •/* markers", () => {
    expect(summaryBullets("• one\n* two")).toEqual(["one", "two"]);
  });

  it("returns [] for a prose paragraph (renders as text, not fake bullets)", () => {
    expect(summaryBullets("During the meeting, Chetan and a colleague discussed feedback and progress.")).toEqual([]);
  });

  it("returns [] for a single bullet (not clearly a list)", () => {
    expect(summaryBullets("- just one point")).toEqual([]);
  });
});
