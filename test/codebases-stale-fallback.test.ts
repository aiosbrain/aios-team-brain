import { describe, it, expect } from "vitest";
import { isCodebaseStale, windowedSpark, STALE_DAYS } from "@/lib/metrics/codebases";

// Spec: a codebase card must NOT blank out when its last scan predates the selected range.
// The headline uses the last scan regardless of window; the card is flagged `stale` only when
// the last scan is older than STALE_DAYS; the sparkline windows the series but never renders empty.

const DAY = 86_400_000;
const now = Date.parse("2026-07-03T00:00:00.000Z");
const daysAgo = (n: number) => new Date(now - n * DAY).toISOString();

describe("isCodebaseStale", () => {
  it("is stale when never scanned", () => {
    expect(isCodebaseStale(null, now)).toBe(true);
  });

  it("is stale when an unparseable timestamp is given", () => {
    expect(isCodebaseStale("not-a-date", now)).toBe(true);
  });

  it("is fresh just inside the threshold, stale just outside", () => {
    expect(isCodebaseStale(daysAgo(STALE_DAYS - 1), now)).toBe(false);
    expect(isCodebaseStale(daysAgo(STALE_DAYS + 1), now)).toBe(true);
  });
});

describe("windowedSpark", () => {
  // newest-first, as the reader groups them
  const series = [
    { scanned_at: daysAgo(1), agentic_score: 70 },
    { scanned_at: daysAgo(5), agentic_score: 60 },
    { scanned_at: daysAgo(40), agentic_score: 50 }, // outside a 30d window
    { scanned_at: daysAgo(80), agentic_score: 40 },
  ];

  it("returns the in-window points oldest→newest", () => {
    const windowStart = daysAgo(30);
    expect(windowedSpark(series, windowStart)).toEqual([60, 70]);
  });

  it("falls back to the most recent points when the window has <2 points (stale repo)", () => {
    // window covers only the newest point → fall back to the last `fallback` points overall.
    const windowStart = daysAgo(3);
    expect(windowedSpark(series, windowStart, 3)).toEqual([50, 60, 70]);
  });

  it("never returns an empty line as long as any scans exist", () => {
    const windowStart = daysAgo(0);
    expect(windowedSpark(series, windowStart).length).toBeGreaterThan(0);
  });

  it("windows correctly when scanned_at is a Date (pg adapter returns Date, not string)", () => {
    // Regression for the #134 gotcha: a lexicographic string compare would never match a Date.
    const dateSeries = [
      { scanned_at: new Date(now - 1 * DAY), agentic_score: 70 },
      { scanned_at: new Date(now - 5 * DAY), agentic_score: 60 },
      { scanned_at: new Date(now - 40 * DAY), agentic_score: 50 }, // outside 30d
    ];
    expect(windowedSpark(dateSeries, daysAgo(30))).toEqual([60, 70]);
  });

  it("coerces string scores (pg numeric comes back as text)", () => {
    const strSeries = [
      { scanned_at: daysAgo(1), agentic_score: "70" },
      { scanned_at: daysAgo(2), agentic_score: "65" },
    ];
    expect(windowedSpark(strSeries, daysAgo(30))).toEqual([65, 70]);
  });
});
