#!/usr/bin/env node
/**
 * CDCCHURN-1 — the sweep behind every number in `docs/design/cdc-boundary-overlap.md`.
 *
 * Committed rather than described, because this ticket's entire history is published measurements that
 * did not reproduce: a prose recipe ("corpus ≥25k, 97-character steps") was re-run by a reviewer and
 * produced different totals, which is exactly the failure the spec is about.
 *
 * IT REPORTS BOTH METRICS, and the difference is the point:
 *
 *   • SET churn — chunks in the edited version whose content is not present anywhere in the original.
 *     This is what the product pays: `lib/graph/project.ts` builds `alreadyPushed = new Set(chunk_shas)`
 *     and filters by MEMBERSHIP, so a chunk whose content survives but whose index shifts is never
 *     re-pushed and costs nothing.
 *   • POSITIONAL churn — chunks whose content differs at the same index. This is NOT a cost, and
 *     mistaking it for one is how an earlier draft of the spec published a maximum of 78 (positional)
 *     for a state that costs 2 (set).
 *
 * Usage: `node scripts/cdc-churn-sweep.mjs [step]` (default step 97). Prints a JSON summary; every
 * figure quoted in the design docs should be traceable to one run of this, stamped with the SHA.
 */
import { readFileSync, readdirSync } from "node:fs";
import { cdcBoundaries, chunkCdc } from "../lib/graph/cdc.ts";

const P = { target: 2500, min: 1250, max: 4000 };
const CAP = 80;
const EDIT_LEN = 20;
const STEP = Number(process.argv[2] ?? 97);

const setChurn = (before, after) => {
  const seen = new Set(before);
  return after.filter((c) => !seen.has(c)).length;
};
const positionalChurn = (before, after) => after.filter((c, i) => before[i] !== c).length;
const chunks = (t) => chunkCdc(t, P, CAP);
const edit = (t, at) => t.slice(0, at) + "X".repeat(EDIT_LEN) + t.slice(at + EDIT_LEN);

/** The same corpus `test/graph-cdc.test.ts` reads. */
function corpus() {
  const out = [];
  for (const dir of ["docs", "docs/design"]) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const text = readFileSync(`${dir}/${f}`, "utf8");
      if (text.length > 4_000) out.push({ path: `${dir}/${f}`, text });
    }
  }
  return out;
}

const predicted = (base, at) => {
  let start = 0;
  let hit = 0;
  for (const c of base) {
    const end = start + c.length;
    if (at < end && at + EDIT_LEN > start) hit++;
    start = end;
  }
  return hit;
};

const summary = {
  step: STEP,
  docs: 0,
  swept: 0,
  unchangedSequence: { samples: 0, ruleAgreesSet: 0, ruleAgreesPositional: 0, mismatches: [] },
  changedSequence: { samples: 0, maxSet: 0, maxSetAt: null, maxPositional: 0, histogramSet: {} },
};

for (const { path, text } of corpus()) {
  summary.docs++;
  if (text.length < 25_000) continue;
  summary.swept++;
  const base = chunks(text);
  const admitted = base.reduce((n, c) => n + c.length, 0);
  const b0 = JSON.stringify(cdcBoundaries(text, P));
  // From 0, not from an arbitrary 1,000: two runs of "the same" sweep differing only in start offset
  // reported different maxima (8 vs 9), which is the whole reason a sparse-grid maximum must be
  // published as an OBSERVED LOWER BOUND rather than as "the maximum".
  for (let at = 0; at + EDIT_LEN < text.length; at += STEP) {
    const after = chunks(edit(text, at));
    const same = JSON.stringify(cdcBoundaries(edit(text, at), P)) === b0;
    const s = setChurn(base, after);
    const p = positionalChurn(base, after);
    if (same) {
      const u = summary.unchangedSequence;
      u.samples++;
      const want = predicted(base, at);
      if (s === want) u.ruleAgreesSet++;
      else if (u.mismatches.length < 5) u.mismatches.push({ path, at, want, set: s });
      if (p === want) u.ruleAgreesPositional++;
      continue;
    }
    if (at + EDIT_LEN >= admitted) continue; // past the admitted prefix: not a cost, not a sample
    const c = summary.changedSequence;
    c.samples++;
    const bucket = s <= 2 ? "2" : s <= 6 ? "3-6" : s <= 20 ? "7-20" : "21+";
    c.histogramSet[bucket] = (c.histogramSet[bucket] ?? 0) + 1;
    if (s > c.maxSet) {
      c.maxSet = s;
      c.maxSetAt = `${path}@${at}`;
    }
    if (p > c.maxPositional) c.maxPositional = p;
  }
}

console.log(JSON.stringify(summary, null, 2));
