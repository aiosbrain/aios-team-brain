import { describe, expect, it } from "vitest";
import { buildImagePrompt } from "@/lib/social/images";
import { startOfUtcDay } from "@/lib/social/settings";

describe("buildImagePrompt", () => {
  const opp = { title: "Shipped arc-sourced discovery", summary: "Turns narrative arcs into posts." };

  it("describes the post + platform style and forbids baked-in text", () => {
    const p = buildImagePrompt(opp, "x");
    expect(p).toContain("x post");
    expect(p).toContain("square (1:1)");
    expect(p).toContain("Shipped arc-sourced discovery");
    expect(p).toContain("Turns narrative arcs into posts.");
    expect(p).toMatch(/Do NOT render any words/i);
  });

  it("uses a landscape style for LinkedIn and a generic style otherwise", () => {
    expect(buildImagePrompt(opp, "linkedin")).toContain("landscape");
    expect(buildImagePrompt(opp, "mastodon")).toContain("clean and professional");
  });
});

describe("startOfUtcDay", () => {
  it("floors to 00:00:00Z of the same UTC day", () => {
    expect(startOfUtcDay(new Date("2026-07-11T18:45:12.000Z"))).toBe("2026-07-11T00:00:00.000Z");
    // just-after-midnight UTC still floors to the same day
    expect(startOfUtcDay(new Date("2026-07-11T00:00:01.000Z"))).toBe("2026-07-11T00:00:00.000Z");
  });
});
