import { describe, expect, it } from "vitest";
import { stripMarkdown, truncate } from "@/components/format";

/**
 * Spec for stripMarkdown: decision titles arrive from a markdown decision log, so the compact card
 * must render them as PLAIN TEXT (no literal `**`, `[..](..)`, backticks). Derived from the display
 * intent (the "**Pause unified inbox GUI**" render bug), not the implementation.
 */
describe("stripMarkdown", () => {
  it("removes bold/italic/strikethrough emphasis", () => {
    expect(stripMarkdown("**Pause unified inbox GUI**")).toBe("Pause unified inbox GUI");
    expect(stripMarkdown("*ship it* and __done__ and ~~scrap~~")).toBe("ship it and done and scrap");
  });

  it("keeps link/image text, drops the URL and backticks", () => {
    expect(stripMarkdown("See [the RFC](https://x.com/rfc) now")).toBe("See the RFC now");
    expect(stripMarkdown("run `npm test` first")).toBe("run npm test first");
    expect(stripMarkdown("![diagram](a.png) shows it")).toBe("diagram shows it");
  });

  it("drops a leading heading/quote/list marker and collapses whitespace", () => {
    expect(stripMarkdown("## Decision:  keep it")).toBe("Decision: keep it");
    expect(stripMarkdown("- **Consolidate** assessments")).toBe("Consolidate assessments");
  });

  it("leaves mid-word underscores in identifiers alone (snake_case, MY_VAR) but still strips _italic_", () => {
    expect(stripMarkdown("Rename user_id to member_id")).toBe("Rename user_id to member_id");
    expect(stripMarkdown("set MY_VAR_NAME in env")).toBe("set MY_VAR_NAME in env");
    expect(stripMarkdown("make it _emphatic_ please")).toBe("make it emphatic please");
  });

  it("handles empty/null and leaves plain text untouched", () => {
    expect(stripMarkdown("")).toBe("");
    expect(stripMarkdown(null)).toBe("");
    expect(stripMarkdown("Onboard Abdul onto the stack")).toBe("Onboard Abdul onto the stack");
  });

  it("strips BEFORE truncation so a cut title can't leave a dangling **", () => {
    const out = truncate(stripMarkdown("**Pause unified inbox GUI** — terminal operator loop remains v1"), 24);
    expect(out).not.toContain("*");
    expect(out.endsWith("…")).toBe(true);
  });
});
