import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * Postgres fixed-window rate limiting (no Vercel KV — self-host portable).
 * Window = 1 minute. Returns true if the call is allowed.
 */

// In-process fixed-window fallback used ONLY when the DB rate-limit RPC errors (audit M3). Previously
// a DB hiccup made rateLimit() return true unconditionally, disabling ALL throttling (incl. auth) at
// once. This keeps a bounded per-instance limit alive during DB stress. Per-instance (one brain), so
// it's a floor, not exact — good enough as a degraded-mode backstop.
const fallbackWindows = new Map<string, { windowStart: number; count: number }>();

function fallbackAllow(bucket: string, limitPerMinute: number, windowStartMs: number): boolean {
  const cur = fallbackWindows.get(bucket);
  if (!cur || cur.windowStart !== windowStartMs) {
    fallbackWindows.set(bucket, { windowStart: windowStartMs, count: 1 });
    // Opportunistic cleanup so the map can't grow unbounded across rotating buckets/windows.
    if (fallbackWindows.size > 10_000) {
      for (const [k, v] of fallbackWindows) if (v.windowStart !== windowStartMs) fallbackWindows.delete(k);
    }
    return 1 <= limitPerMinute;
  }
  cur.count += 1;
  return cur.count <= limitPerMinute;
}

export async function rateLimit(
  db: DbClient,
  bucket: string,
  limitPerMinute: number
): Promise<boolean> {
  const windowStart = new Date();
  windowStart.setSeconds(0, 0);
  const { data, error } = await db.rpc("rate_limit_hit", {
    p_bucket: bucket,
    p_window_start: windowStart.toISOString(),
  });
  if (error) return fallbackAllow(bucket, limitPerMinute, windowStart.getTime()); // degrade, don't open
  return (data as number) <= limitPerMinute;
}
