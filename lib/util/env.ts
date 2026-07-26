/**
 * Parse a positive-integer env knob, falling back to `fallback` on anything malformed.
 *
 * Lives here rather than in any one feature because several unrelated subsystems need the same
 * fail-safe reading of a tuning knob, and importing it from (say) the graph projector would drag a
 * server-only module with a Graphiti client into the dashboard just to read a number.
 *
 * The care is deliberate: `Number("")` is 0 and `Number("abc")` is NaN, and a 0/NaN limit silently turns
 * "fetch a bounded page" into "fetch nothing" — the caller then succeeds while reporting an empty world.
 * `Math.floor` closes the fractional hole (0.5 → 0). Pure + unit-tested.
 */
export function resolvePositiveInt(raw: unknown, fallback: number): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}
