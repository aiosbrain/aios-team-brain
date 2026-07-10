import { describe, expect, it } from "vitest";
import { rateLimit } from "@/lib/api/rate-limit";
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
