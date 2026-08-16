/**
 * Shared IN-clause batching (extracted from lib/graph/project so read-only modules can import it
 * without pulling in — or cycling with — the projector).
 *
 * How many ids go into one `.in(...)` filter. The pg adapter binds each element separately and
 * Postgres hard-caps a statement at 65535 binds, so an unbounded list is a query that simply stops
 * working once a team's corpus grows — silently, at exactly the scale where it matters most.
 */
export const IN_CLAUSE_BATCH = 1000;

/** Split into fixed-size batches. Pure. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
