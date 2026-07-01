/**
 * Timezone resolution for query date-anchoring. Relative dates ("today", "this week") must be
 * interpreted in the ASKER's timezone, not the server's UTC — a commit made at 05:00 UTC is
 * "this afternoon" for a GMT+8 user, so a UTC-only anchor mis-buckets their own recent work.
 *
 * Pure + dependency-free (Intl only) so it unit-tests without a DB or a clock.
 */

/** Instance-wide fallback when we have no better signal (browser tz / member profile). */
export const DEFAULT_TIMEZONE = process.env.BRAIN_DEFAULT_TIMEZONE || "UTC";

/** True when `tz` is a resolvable IANA timezone (e.g. "Asia/Singapore", "UTC"). */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * First valid IANA timezone from the candidates, else "UTC". Callers pass their preference order,
 * e.g. [browserTz, memberProfileTz, DEFAULT_TIMEZONE] — most-specific/most-accurate first.
 */
export function pickTimezone(candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    const tz = c?.trim();
    if (tz && isValidTimeZone(tz)) return tz;
  }
  return "UTC";
}
