import { describe, expect, it } from "vitest";
import { BASE_BACKOFF_MS, MAX_BACKOFF_MS, backoffMs, nextRunAfter } from "@/lib/jobs/backoff";

/**
 * Spec for the retry schedule: it must grow exponentially from BASE and never exceed MAX, so a
 * flapping provider is retried politely (not hammered) and a long-lived job can't push its next
 * attempt beyond the cap. Derived from the retry intent, not the implementation.
 */
describe("job backoff", () => {
  it("doubles per attempt starting at BASE", () => {
    expect(backoffMs(1)).toBe(BASE_BACKOFF_MS); // first retry waits BASE
    expect(backoffMs(2)).toBe(BASE_BACKOFF_MS * 2);
    expect(backoffMs(3)).toBe(BASE_BACKOFF_MS * 4);
  });

  it("caps at MAX_BACKOFF_MS and never overflows for large attempt counts", () => {
    expect(backoffMs(100)).toBe(MAX_BACKOFF_MS);
    expect(Number.isFinite(backoffMs(1000))).toBe(true);
    expect(backoffMs(1000)).toBe(MAX_BACKOFF_MS);
  });

  it("treats attempts < 1 as the first retry (no negative/zero delay)", () => {
    expect(backoffMs(0)).toBe(BASE_BACKOFF_MS);
    expect(backoffMs(-5)).toBe(BASE_BACKOFF_MS);
  });

  it("nextRunAfter offsets the given clock by the backoff", () => {
    const now = new Date("2026-07-10T12:00:00.000Z");
    expect(nextRunAfter(1, now).getTime()).toBe(now.getTime() + BASE_BACKOFF_MS);
    expect(nextRunAfter(2, now).getTime()).toBe(now.getTime() + BASE_BACKOFF_MS * 2);
  });
});
