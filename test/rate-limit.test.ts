import { describe, expect, it } from "vitest";
import { rateLimit, rateLimitWithReset } from "@/lib/api/rate-limit";
import type { DbClient } from "@/lib/db/types";

/**
 * Spec for audit finding M3: when the DB rate-limit RPC errors, rateLimit() previously returned
 * true unconditionally — disabling ALL throttling (incl. auth) at once during DB stress. It must
 * now degrade to an in-process bound instead of failing fully open.
 */

/** A client whose rpc always errors, to force the fallback path. */
const erroringDb = {
  rpc: async () => ({ data: null, error: { message: "db down" } }),
} as unknown as DbClient;

/** A client whose rpc succeeds and reports a low hit count (always under the limit). */
const healthyDb = {
  rpc: async () => ({ data: 1, error: null }),
} as unknown as DbClient;

describe("rateLimit degraded mode (audit M3)", () => {
  it("still throttles when the DB errors instead of failing fully open", async () => {
    const bucket = `test-fallback-${Math.random().toString(36).slice(2)}`;
    const results: boolean[] = [];
    for (let i = 0; i < 6; i++) results.push(await rateLimit(erroringDb, bucket, 2));

    // First call is allowed (not failing closed)...
    expect(results[0]).toBe(true);
    // ...but not every call is allowed — the old behavior returned true for all 6 (fully open).
    expect(results.filter((r) => r === false).length).toBeGreaterThan(0);
  });

  it("allows normally when the DB is healthy and under the limit", async () => {
    const bucket = `test-healthy-${Math.random().toString(36).slice(2)}`;
    expect(await rateLimit(healthyDb, bucket, 60)).toBe(true);
  });
});

describe("fixed-window reset guidance", () => {
  it.each([
    ["2026-08-31T12:34:00.000Z", 60],
    ["2026-08-31T12:34:59.999Z", 1],
  ])("returns an integer boundary for %s", async (nowIso, expectedSeconds) => {
    const result = await rateLimitWithReset(
      healthyDb,
      `test-reset-${nowIso}`,
      0,
      new Date(nowIso),
    );

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(expectedSeconds);
    expect(Number.isInteger(result.retryAfterSeconds)).toBe(true);
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("uses the same sampled window start for the database decision and reset", async () => {
    const calls: Array<{ p_bucket: string; p_window_start: string }> = [];
    const db = {
      rpc: async (_name: string, args: { p_bucket: string; p_window_start: string }) => {
        calls.push(args);
        return { data: 61, error: null };
      },
    } as unknown as DbClient;

    const result = await rateLimitWithReset(
      db,
      "key-1:codebases:post",
      60,
      new Date("2026-08-31T12:34:17.250Z"),
    );

    expect(calls).toEqual([
      { p_bucket: "key-1:codebases:post", p_window_start: "2026-08-31T12:34:00.000Z" },
    ]);
    expect(result).toEqual({ allowed: false, retryAfterSeconds: 43 });
  });
});
