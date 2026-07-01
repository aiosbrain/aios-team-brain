import { describe, expect, it } from "vitest";
import { isValidTimeZone, pickTimezone } from "@/lib/query/timezone";

// Spec: relative-date anchoring must use the asker's timezone, resolved from the most accurate
// available signal (browser → member profile → instance default), and never crash on bad input.

describe("isValidTimeZone", () => {
  it("accepts IANA zones and UTC", () => {
    expect(isValidTimeZone("Asia/Singapore")).toBe(true);
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
  });
  it("rejects garbage and empties", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("nonsense")).toBe(false);
  });
});

describe("pickTimezone", () => {
  it("returns the first valid candidate in preference order", () => {
    expect(pickTimezone(["Asia/Singapore", "UTC"])).toBe("Asia/Singapore");
    expect(pickTimezone([null, "  ", "bogus", "Europe/Paris"])).toBe("Europe/Paris");
  });
  it("trims candidates before validating", () => {
    expect(pickTimezone(["  Asia/Tokyo  "])).toBe("Asia/Tokyo");
  });
  it("falls back to UTC when nothing is valid", () => {
    expect(pickTimezone([null, undefined, "", "nope"])).toBe("UTC");
    expect(pickTimezone([])).toBe("UTC");
  });
});
