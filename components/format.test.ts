import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fmtDate, timeAgo, truncate } from "@/components/format";

describe("timeAgo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-14T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("returns em-dash for null/invalid", () => {
    expect(timeAgo(null)).toBe("—");
    expect(timeAgo("not-a-date")).toBe("—");
  });
  it("bins recent times", () => {
    expect(timeAgo("2026-06-14T11:59:30Z")).toBe("just now");
    expect(timeAgo("2026-06-14T11:30:00Z")).toBe("30m ago");
    expect(timeAgo("2026-06-14T09:00:00Z")).toBe("3h ago");
  });
  it("bins days and months", () => {
    expect(timeAgo("2026-06-09T12:00:00Z")).toBe("5d ago");
    expect(timeAgo("2026-05-10T12:00:00Z")).toBe("1mo ago");
  });
});

describe("truncate", () => {
  it("leaves short strings intact", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });
  it("adds an ellipsis past the limit", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
});

describe("fmtDate", () => {
  it("formats a valid date and dashes invalid", () => {
    expect(fmtDate("2026-06-14T00:00:00Z")).toMatch(/2026/);
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate("garbage")).toBe("—");
  });
});
