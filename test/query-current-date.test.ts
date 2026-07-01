import { describe, expect, it } from "vitest";
import { currentDateLine } from "@/lib/query/claude";

/**
 * Spec: the query prompt must anchor relative dates in the ASKER's timezone, and define "today" as
 * a rolling 24h window (not the server's UTC calendar day). Derived from the product requirement —
 * a GMT+8 user's 05:00-UTC commit is "today" for them, and a UTC-only anchor mis-bucketed it as
 * yesterday. The window cutoff is an explicit UTC instant so the model can compare digest dates.
 */

describe("currentDateLine", () => {
  it("states NOW in the given timezone with weekday and UTC offset", () => {
    // 2026-07-01T05:05:00Z is 13:05 on 2026-07-01 in UTC+8 (a Wednesday).
    const line = currentDateLine(new Date("2026-07-01T05:05:00Z"), "Asia/Singapore");
    expect(line).toContain("2026-07-01 13:05");
    expect(line).toContain("Wednesday");
    expect(line).toContain("Asia/Singapore");
    expect(line).toContain("UTC+08:00");
  });

  it("crosses the date line: an evening-UTC instant is already tomorrow in +8", () => {
    // 2026-06-30T20:00:00Z is 2026-07-01 04:00 in UTC+8.
    const line = currentDateLine(new Date("2026-06-30T20:00:00Z"), "Asia/Singapore");
    expect(line).toContain("2026-07-01 04:00");
  });

  it('defines "today" as the trailing 24h with an explicit UTC cutoff', () => {
    const now = new Date("2026-07-01T05:05:00Z");
    const line = currentDateLine(now, "Asia/Singapore");
    expect(line).toMatch(/last 24 hours/i);
    // cutoff = now - 24h = 2026-06-30T05:05:00Z
    expect(line).toContain("2026-06-30T05:05:00.000Z");
  });

  it("falls back to UTC for an unknown timezone", () => {
    const line = currentDateLine(new Date("2026-06-26T09:30:00Z"), "Not/AZone");
    expect(line).toContain("2026-06-26 09:30");
    expect(line).toContain("UTC (UTC+00:00)");
  });

  it("defaults to UTC when no timezone is given", () => {
    const line = currentDateLine(new Date("2026-06-26T23:30:00Z"));
    expect(line).toContain("2026-06-26 23:30");
    expect(line).toContain("UTC");
  });
});
