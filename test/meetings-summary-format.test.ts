import { describe, expect, it } from "vitest";
import { summaryBullets, meetingSynopsis } from "@/lib/meetings/summary-format";

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

/**
 * Spec for the list-card synopsis: a compact 1–3 "sentence" preview so meetings are skimmable. Bullets
 * become sentence units; prose keeps its sentences; markers are stripped; empty → "".
 */
describe("meetingSynopsis", () => {
  it("turns the first up-to-3 bullets into a sentence-y synopsis", () => {
    const s = "- Discussed the dashboard\n- Decided to use gbrain + Hermes\n- Next: configure setups\n- Extra point not shown";
    const out = meetingSynopsis(s);
    expect(out).toContain("Discussed the dashboard");
    expect(out).toContain("Next: configure setups");
    expect(out).not.toContain("Extra point not shown"); // capped at 3
  });

  it("keeps the leading sentences of a prose summary and drops markdown markers", () => {
    const s = "# Kickoff\nWe scoped the migration. The team agreed on a plan. Risks were noted. A fourth thing.";
    const out = meetingSynopsis(s, 3);
    expect(out.startsWith("Kickoff")).toBe(true);
    expect(out).toContain("agreed on a plan");
    expect(out).not.toContain("A fourth thing");
  });

  it("caps length with an ellipsis and returns '' for an empty/unusable summary", () => {
    expect(meetingSynopsis("")).toBe("");
    expect(meetingSynopsis(null)).toBe("");
    const long = meetingSynopsis("A ".repeat(400), 3, 240);
    expect(long.length).toBeLessThanOrEqual(241);
    expect(long.endsWith("…")).toBe(true);
  });

  it("handles the JSON-array summary shape (via normalizeSummaryField)", () => {
    expect(meetingSynopsis(["First point", "Second point"])).toContain("First point");
  });

  it("does not fracture version numbers / decimals (v1.2 stays intact)", () => {
    const out = meetingSynopsis("- Shipped v1.2 of ingest\n- Cut costs by 3.5x");
    expect(out).toContain("v1.2");
    expect(out).toContain("3.5x");
    expect(out).not.toMatch(/v1\. 2/);
  });

  it("does not produce '!.' / '?.' artifacts for bullets ending in ! or ?", () => {
    const out = meetingSynopsis("- Shipped it!\n- Are we done?");
    expect(out).not.toContain("!.");
    expect(out).not.toContain("?.");
  });
});
