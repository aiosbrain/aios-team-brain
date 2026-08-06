/**
 * Phase A, part 1 — what the ten predecessors actually contain, WITHOUT spending anything
 * (PIPEFF-2 / AIO-821).
 *
 * Two of Phase A's three questions do not need an LLM run:
 *
 *   · SAME-ITEM SHARE is derivable. Given the tie-rank guarantee (an item's own chunks share
 *     `valid_at` with the episode being extracted, which is the MAXIMUM the `valid_at <=
 *     reference_time` filter admits, so they outrank every strictly-earlier row), chunk k of an item
 *     receives exactly min(k, 10) of its own prior chunks and 10 - min(k, 10) unrelated fillers.
 *   · TIE-POOL CONTAMINATION is a SQL query: another item with a byte-identical `work_at` competes
 *     for the same ten slots, and it competes with one row PER CHUNK, so the honest unit is rival
 *     EPISODES rather than rival items.
 *
 * Only the third question — the token SIZE of the predecessor block per call kind — needs the stack
 * and the money. Running this first means the expensive half is entered with a prediction already on
 * the record, which is the whole point of Phase A.
 *
 * Read-only against prod. Usage:
 *   DATABASE_URL=<prod public URL> node scripts/graph-window-battery/phase-a-structural.mjs
 */
import { Client } from "pg";
import { selectCorpus, CANDIDATE_SQL, CHUNK_CHARS, MAX_EPISODE_CHUNKS, blankBodySql, PROJECTABLE_KINDS } from "./corpus.mjs";

const KINDS = PROJECTABLE_KINDS;
// Gate SSL the way the sibling scripts do, so this also runs against a plain local Postgres.
const url = process.env.DATABASE_URL ?? "";
const needsSsl = /\bsslmode=require\b/.test(url) || /\.rlwy\.net|proxy\.rlwy\.net|railway/.test(url);
const c = new Client({ connectionString: url, ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}) });
await c.connect();

// Deterministic: `limit 1` with no ORDER BY picks an arbitrary row on a multi-team install.
const t = await c.query("select id, slug from teams order by created_at, id limit 1");
const teamId = t.rows[0].id;
const { rows } = await c.query(CANDIDATE_SQL, [teamId, KINDS]);
const got = selectCorpus(rows.map((r) => ({ ...r, chars: Number(r.chars) })));

// ANALYTIC same-item share. For chunk k (0-based) of an item, the window holds min(k,10) of that
// item's own prior chunks and 10-min(k,10) unrelated fillers — guaranteed by the valid_at tie rank
// (own chunks sit AT reference_time, the maximum the filter admits, so they outrank every earlier
// row). No LLM call needed to know this; the only empirical unknowns are contamination and size.
let own = 0, filler = 0, ownMulti = 0, fillerMulti = 0, singleSlots = 0;
for (const it of got.items) {
  for (let k = 0; k < it.chunks; k++) {
    const o = Math.min(k, 10);
    const f = 10 - o;
    own += o;
    filler += f;
    if (it.chunks > 1) { ownMulti += o; fillerMulti += f; } else { singleSlots += f; }
  }
}
const pct = (a, b) => (a + b === 0 ? "n/a" : ((a / (a + b)) * 100).toFixed(1) + "%");

console.log("PREDECESSOR SLOTS across the corpus (analytic, from the tie-rank guarantee)");
console.log(`  overall       same-item ${pct(own, filler)}   (${own} own / ${filler} unrelated slots)`);
console.log(`  multi-chunk   same-item ${pct(ownMulti, fillerMulti)}`);
console.log(`  single-chunk  same-item 0.0%   (${singleSlots} slots, all unrelated — nothing to be a chunk of)`);

// TIE-POOL CONTAMINATION — the one way the guarantee breaks: another item in the same group with a
// byte-identical `work_at` competes for the same ten slots. It competes with one row PER CHUNK, so
// the honest unit is rival EPISODES; counting rival ITEMS understates a 40-chunk rival 40-fold.
const rival = await c.query(
  `select i.id, i.path, coalesce(sum(least(ceil(length(o.body)::numeric / $4), $5)), 0)::int as rival_eps
     from items i
     left join items o
       on o.team_id = i.team_id and o.access = i.access and o.work_at = i.work_at
      and o.id <> i.id and o.kind = any($3) and not (${blankBodySql('o.body')})
    where i.id = any($1) and i.team_id = $2
    group by i.id, i.path
    order by rival_eps desc`,
  [got.items.map((i) => i.id), teamId, KINDS, CHUNK_CHARS, MAX_EPISODE_CHUNKS]
);
const byId = new Map(rival.rows.map((r) => [r.id, r.rival_eps]));

// For chunk k with R rival episodes at the same rank, the tie pool is k + R for 10 slots. When the
// pool overflows, the own chunks expected to survive are ~10 * k/(k+R) — Cypher does not define the
// order among ties, so this is the expectation rather than a bound.
let promised = 0;
let expected = 0;
for (const it of got.items) {
  const R = byId.get(it.id) ?? 0;
  for (let k = 0; k < it.chunks; k++) {
    const ideal = Math.min(k, 10);
    promised += ideal;
    expected += k + R <= 10 ? ideal : (10 * k) / (k + R);
  }
}
const contaminated = rival.rows.filter((r) => r.rival_eps > 0);
console.log("\nTIE-POOL CONTAMINATION (rival EPISODES sharing an exact work_at)");
console.log(`  corpus items with any rival: ${contaminated.length} of ${rival.rows.length}`);
console.log(`  worst single item:           ${Math.max(0, ...rival.rows.map((r) => r.rival_eps))} rival episodes`);
console.log(`  own-chunk slots promised:    ${promised}`);
console.log(`  expected to survive:         ${expected.toFixed(1)} (${((expected / promised) * 100).toFixed(1)}%)`);
console.log("\n  The SAME filter removes rival displacement entirely — own chunks are the only candidates.");

await c.end();
