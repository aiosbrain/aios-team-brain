/**
 * Pure formatting helpers for the ingest-runs admin panel. Kept separate from lib/ingest/runs
 * (which is `server-only`) so they render in any component and unit-test without a DB.
 */

/**
 * Compact "just now" / "3m ago" / "2h ago" / "5d ago" from two epoch-ms instants (floored).
 * `nowMs` defaults to the current time HERE (a lib module, not a component) so the panel can call
 * `relativeAge(when)` without tripping the React purity rule; tests pass it explicitly.
 */
export function relativeAge(fromMs: number, nowMs: number = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Whether a source's most-recent successful run is stale enough to warn about. This is the signal
 * that would have surfaced the silent scan-on-merge breakage ("commits: last scan 6 days ago ⚠️").
 */
export function isStale(lastOkMs: number | null, nowMs: number, maxAgeHours: number): boolean {
  if (lastOkMs == null) return true; // never succeeded → definitely worth a warning
  return nowMs - lastOkMs > maxAgeHours * 60 * 60 * 1000;
}
