import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * Postgres fixed-window rate limiting (no Vercel KV — self-host portable).
 * Window = 1 minute. Returns true if the call is allowed.
 */
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
  if (error) return true; // fail-open on infrastructure error (audited elsewhere)
  return (data as number) <= limitPerMinute;
}
