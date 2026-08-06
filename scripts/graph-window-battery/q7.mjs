/**
 * Q7's pure halves (Amendment 2, PIPEFF-2 / AIO-821) — in .mjs so BOTH consumers can import them:
 * `measure.ts` (harvest side, via tsx) and `judge.mjs` (plain node). Two implementations of the
 * universe rule would be the parallel-implementation drift this battery already guards against
 * twice; one module is the guard.
 */

export const normName = (s) => String(s ?? "").trim().toLowerCase();

/**
 * The universe: names the INCUMBENT found that recur in the source text — union of W10's reps'
 * entity names, kept when the name appears literally (case-insensitive) in ≥ 2 distinct corpus
 * items, length ≥ 3, non-numeric. No answer key: presence is checked against corpus bodies, and the
 * universe is fixed by the incumbent, so every arm is asked the same differential question.
 */
export function buildUniverse(w10NameCountReps, items) {
  const candidates = new Set();
  for (const rep of w10NameCountReps) for (const { name } of rep) candidates.add(normName(name));

  const bodies = items.map((i) => (i.body ?? "").toLowerCase());
  const universe = [];
  for (const name of candidates) {
    if (name.length < 3 || /^\d+$/.test(name)) continue;
    let count = 0;
    for (const b of bodies) if (b.includes(name)) count++;
    if (count >= 2) universe.push(name);
  }
  return universe.sort();
}

/**
 * Q7 for one rep: distinct nodes carrying a universe name, per universe name. Fragmentation makes
 * this RISE — the same recurring project/person/tool as several parallel nodes.
 */
export function nameConvergence(nameCounts, universe) {
  if (universe.length === 0) return 0;
  const byName = new Map(nameCounts.map((r) => [normName(r.name), r.nodes]));
  const total = universe.reduce((s, n) => s + (byName.get(n) ?? 0), 0);
  return total / universe.length;
}
