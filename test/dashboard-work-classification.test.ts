import { describe, expect, it } from "vitest";
import { classifyWork } from "@/lib/dashboard/work-classification";

/**
 * Spec: WORK (a person's output — code/docs) vs SIGNAL (data about work — decisions/meetings). The
 * load-bearing case is SLACK: threads are stored kind:"transcript" but are per-person WORK, so the
 * transcript rule must carve Slack OUT. Pure, no DB.
 */

describe("classifyWork — WORK vs SIGNAL", () => {
  it("classifies work OUTPUT as work", () => {
    expect(classifyWork("deliverable", "github")).toBe("work");
    expect(classifyWork("artifact", "git")).toBe("work");
    expect(classifyWork("skill", "cli")).toBe("work");
    expect(classifyWork("blueprint", "cli")).toBe("work");
  });

  it("classifies data-ABOUT-work as signal", () => {
    expect(classifyWork("decision", "cli")).toBe("signal");
    expect(classifyWork("transcript", "granola")).toBe("signal"); // a meeting
    expect(classifyWork("deliverable", "calendar")).toBe("signal"); // a signal SOURCE overrides kind
  });

  it("SLACK threads are WORK even though they're stored kind:transcript (the carve-out)", () => {
    expect(classifyWork("transcript", "slack")).toBe("work");
  });

  it("defaults an unknown/future item_kind to work (never silently mislabels output as signal)", () => {
    expect(classifyWork("newkind", "github")).toBe("work");
    expect(classifyWork(null, null)).toBe("work");
  });
});
