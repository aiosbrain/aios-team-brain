import { describe, expect, it } from "vitest";
import { currentDateLine } from "@/lib/query/claude";

/**
 * Spec: the query prompt must state today's date so the brain can resolve relative dates
 * ("today", "this week"). Derived from the product requirement (the brain should know when
 * "today" is), not the implementation. UTC, with the weekday, matching the digest date basis.
 */

describe("currentDateLine", () => {
  it("states the given date as a UTC calendar date with weekday", () => {
    // 2026-06-26 is a Friday (UTC).
    const line = currentDateLine(new Date("2026-06-26T09:30:00Z"));
    expect(line).toBe("Current date: 2026-06-26 (Friday, UTC).");
  });

  it("uses the UTC day even when the local time would roll to the next date", () => {
    // 23:30Z on the 26th is still the 26th in UTC regardless of the runner's timezone.
    const line = currentDateLine(new Date("2026-06-26T23:30:00Z"));
    expect(line).toContain("2026-06-26");
    expect(line).toContain("Friday");
  });

  it("defaults to now() and yields a well-formed line", () => {
    expect(currentDateLine()).toMatch(/^Current date: \d{4}-\d{2}-\d{2} \([A-Z][a-z]+, UTC\)\.$/);
  });
});
