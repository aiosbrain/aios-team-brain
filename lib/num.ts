/** Shared numeric helpers for the metrics + scoring layer (client-safe; pure). */

/** Clamp `n` into [lo, hi] (defaults to a 0–100 score range). */
export const clamp = (n: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, n));

/** Round to `dp` decimal places (default 2). */
export const round = (n: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Coerce a possibly-string Postgres numeric (supabase-js returns numerics as
 * strings) to a number; null/undefined/NaN → 0. */
export const num = (v: number | string | null | undefined): number =>
  v == null ? 0 : Number(v) || 0;

/**
 * Like `num`, but PRESERVES null instead of collapsing it to 0. Use this for any metric where
 * "not measured" is a real, distinct state — `num()` silently turns an unknown into a zero,
 * which for a score is a claim you did not measure (a repo that never filed a coverage report
 * reading as a repo measured at 0%). NaN still degrades to null rather than leaking through.
 */
export const numOrNull = (v: number | string | null | undefined): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
