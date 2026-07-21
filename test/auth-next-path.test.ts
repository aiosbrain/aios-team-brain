import { describe, expect, it } from "vitest";
import { safeNextPath } from "@/lib/auth/next-path";

// safeNextPath is the shared post-login redirect sanitizer for the login, magic-link, and confirm
// routes. It must only ever return a same-origin absolute path — the bar a naive
// startsWith("/") && !startsWith("//") check fails to clear.
describe("safeNextPath", () => {
  it("keeps a plain same-origin path (with query + hash)", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/t/acme?tab=work#top")).toBe("/t/acme?tab=work#top");
    expect(safeNextPath("/")).toBe("/");
  });

  it("collapses missing / empty / non-absolute targets to /", () => {
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("dashboard")).toBe("/");
    expect(safeNextPath("https://evil.com")).toBe("/");
  });

  it("rejects every off-origin bypass the WHATWG URL parser would otherwise resolve away", () => {
    // protocol-relative
    expect(safeNextPath("//evil.com")).toBe("/");
    // backslash treated as slash by new URL()
    expect(safeNextPath("/\\evil.com")).toBe("/");
    expect(safeNextPath("/\\/evil.com")).toBe("/");
    // tab/newline stripped by the parser before resolving
    expect(safeNextPath("/\t/evil.com")).toBe("/");
    expect(safeNextPath("/\n/evil.com")).toBe("/");
  });
});
