/**
 * Exponential backoff for retryable job failures. Pure + deterministic (no clock, no jitter) so
 * the retry schedule is unit-testable and the data-mechanics tier can drive multiple rounds by
 * advancing an injected clock. Kept separate from the store/runner for that reason.
 */

/** Base delay before the first retry. */
export const BASE_BACKOFF_MS = 30_000; // 30s
/** Ceiling so a long-lived job can't push its next attempt hours out. */
export const MAX_BACKOFF_MS = 60 * 60_000; // 1h

/**
 * Delay before the next attempt, given how many attempts have already run. Doubles per attempt
 * (30s, 60s, 120s, …) capped at MAX_BACKOFF_MS. `attempts` is the count already made (≥1 when a
 * failure is being scheduled), so attempt 1 waits BASE, attempt 2 waits 2×BASE, and so on.
 */
export function backoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  // 2^(n-1) can overflow for large n; cap the exponent before shifting.
  const exp = Math.min(n - 1, 30);
  return Math.min(BASE_BACKOFF_MS * 2 ** exp, MAX_BACKOFF_MS);
}

/** The absolute time the next attempt becomes eligible, from a base clock. */
export function nextRunAfter(attempts: number, now: Date): Date {
  return new Date(now.getTime() + backoffMs(attempts));
}
