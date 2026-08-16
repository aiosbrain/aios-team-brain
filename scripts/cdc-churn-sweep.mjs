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
 * CDCAPPEND-1 adds `--op append`, for the `append at end` row one line down. Same reason, same shape:
 * four characterisations of that row have been falsified, and the fourth was falsified BY this script.
 *
 * Usage:
 *   `node scripts/cdc-churn-sweep.mjs [step]`          — in-place sweep (default; step 97)
 *   `node scripts/cdc-churn-sweep.mjs --op append`     — append sweep over documents x append lengths
 *   `… --corpus wide`                                  — the >4,000-character corpus instead of the test's
 *
 * Prints a JSON summary; every figure quoted in the design docs should be traceable to one run of this,
 * stamped with the SHA.
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cdcBoundaries, chunkCdc } from "../lib/graph/cdc.ts";

/**
 * Every run stamps the revision it measured, because the corpus is live and this ticket's own history
 * is published numbers that stopped reproducing. `dirty` matters as much as the SHA: a sweep over an
 * edited working tree is not a measurement of that commit — and the design documents ARE in the corpus,
 * so editing the spec that quotes these numbers changes them.
 */
function revision() {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: null, dirty: null }; // not a checkout — report unknown rather than a plausible lie
  }
}

const P = { target: 2500, min: 1250, max: 4000 };
const CAP = 80;
const EDIT_LEN = 20;
const ARGV = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = ARGV.indexOf(`--${name}`);
  return i >= 0 && ARGV[i + 1] !== undefined ? ARGV[i + 1] : fallback;
};
const OP = flag("op", "inplace");
const STEP = Number(flag("step", ARGV.find((a) => /^\d+$/.test(a)) ?? 97));

const setChurn = (before, after) => {
  const seen = new Set(before);
  return after.filter((c) => !seen.has(c)).length;
};
const positionalChurn = (before, after) => after.filter((c, i) => before[i] !== c).length;
const chunks = (t) => chunkCdc(t, P, CAP);
const edit = (t, at) => t.slice(0, at) + "X".repeat(EDIT_LEN) + t.slice(at + EDIT_LEN);
/** The byte-offset chunker, inlined: `lib/graph/project.ts` cannot be imported by bare node. */
const legacyChunks = (t) => {
  if (!t.trim()) return [];
  const out = [];
  for (let i = 0; i < t.length && out.length < CAP; i += P.target) out.push(t.slice(i, i + P.target));
  return out;
};

/**
 * TWO corpus definitions, and the difference is load-bearing.
 *
 * `test` is the one `test/graph-cdc.test.ts:repoDocs()` reads — three directories, >= 15,000 characters.
 * `wide` is this script's original >4,000-character set over two directories. A comment here used to
 * claim the wide set WAS the test's, which is the class of false claim this whole ticket is about: a
 * number measured over one population and asserted over another.
 */
const CORPORA = {
  test: { dirs: ["docs", "docs/design", "."], minLength: 15_000 },
  wide: { dirs: ["docs", "docs/design"], minLength: 4_001 },
};
function corpus(which = "wide") {
  const { dirs, minLength } = CORPORA[which] ?? CORPORA.wide;
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      if (!f.endsWith(".md")) continue;
      const path = `${dir}/${f}`;
      if (seen.has(path)) continue;
      seen.add(path);
      const text = readFileSync(path, "utf8");
      if (text.length >= minLength) out.push({ path, text });
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

// ── `--op append` (CDCAPPEND-1) ──────────────────────────────────────────────────────────────────

/** Append lengths spanning every regime: under `min`, around `target`, and several multiples of it. */
const APPEND_LENGTHS = [1, 66, 700, 1_249, 1_251, 2_500, 5_000, 9_000, 20_000, 60_000];

/**
 * Filler with a per-token index, so no two chunks of it can be byte-equal.
 *
 * Not cosmetic: the first version of this sweep used cyclic filler, whose chunks DO repeat, and the set
 * metric then reported fewer changed chunks than the bound — which reads as a rule violation and is
 * actually the duplicate-content case. The duplicate case gets its own deliberate probe below instead.
 */
const filler = (n, tag) => {
  let s = "";
  let i = 0;
  while (s.length < n) s += `${tag}${i} lorem ipsum dolor sit amet consectetur ${i * 7919} `, i++;
  return s.slice(0, n);
};

/**
 * THE BOUND. `L` = the length of the common prefix of the two boundary sequences — the last boundary the
 * two chunkings share. Chunks `0..L-1` are byte-identical, so at most the admitted chunks after `L` can
 * be re-pushed. An upper bound by construction; measured tight everywhere except duplicate content.
 */
const appendBound = (b0, b1) => {
  let l = 0;
  while (l < b0.length && l < b1.length && b0[l] === b1[l]) l++;
  return { shared: l, bound: Math.max(0, Math.min(CAP, b1.length) - l) };
};

if (OP === "append") {
  const which = flag("corpus", "test");
  const docs = corpus(which);
  const out = {
    op: "append",
    revision: revision(),
    corpus: { ...CORPORA[which], name: which, docs: docs.length },
    lengths: APPEND_LENGTHS,
    samples: 0,
    boundHolds: 0,
    boundTightSet: 0,
    boundTightPositional: 0,
    violations: [],
    slack: [],
    depthHistogram: {},
    movedOutsideMaxWindow: 0,
    perLength: {},
    candidate1: { name: "1 + new chunks, or 0 when capped", agrees: 0, samples: 0, misses: [] },
    legacy: {},
    duplicateProbe: null,
  };

  // Two append CONTENTS at every length — ordinary prose and a hash-quiet run, which produce different
  // churn at the same length (see the `legacy` block). A rule verified against one filler is verified
  // against one shape of appended text, which is not the claim the table makes.
  const BOUND_FILLERS = { prose: (n) => filler(n, "z"), quiet: (n) => "a".repeat(n) };
  for (const { path, text } of docs) {
    const base = chunks(text);
    const b0 = cdcBoundaries(text, P);
    for (const len of APPEND_LENGTHS) for (const [fname, make] of Object.entries(BOUND_FILLERS)) {
      const appended = text + make(len);
      const after = chunks(appended);
      const b1 = cdcBoundaries(appended, P);
      const { shared, bound } = appendBound(b0, b1);
      const s = setChurn(base, after);
      const p = positionalChurn(base, after);
      out.samples++;
      if (s <= bound) out.boundHolds++;
      else out.violations.push({ path, len, filler: fname, bound, set: s, shared });
      if (s === bound) out.boundTightSet++;
      else if (s < bound) out.slack.push({ path, len, filler: fname, bound, set: s, positional: p });
      if (p === bound) out.boundTightPositional++;
      const depth = b0.length - shared;
      out.depthHistogram[depth] = (out.depthHistogram[depth] ?? 0) + 1;
      // Structural claim: a boundary whose chunk START sits at least `max` before the original end is
      // computed from unchanged input and cannot move.
      const lastSharedEnd = shared > 0 ? b0[shared - 1] : 0;
      if (text.length - lastSharedEnd > P.max) out.movedOutsideMaxWindow++;
      const bucket = (out.perLength[`${len}/${fname}`] ??= {});
      bucket[s] = (bucket[s] ?? 0) + 1;
      // The falsified fourth characterisation, kept runnable so the refutation reproduces.
      const c1 = b0.length >= CAP ? 0 : 1 + Math.max(0, Math.min(CAP, b1.length) - b0.length);
      out.candidate1.samples++;
      if (c1 === s) out.candidate1.agrees++;
      else if (out.candidate1.misses.length < 6)
        out.candidate1.misses.push({ path, len, filler: fname, said: c1, was: s });
    }
  }

  // CDC vs the byte-offset chunker, PER DOCUMENT — the comparison `test/graph-cdc.test.ts` makes as
  // max-versus-max across different documents, which is how it passes while CDC is strictly worse.
  //
  // SWEPT ACROSS THREE APPEND CONTENTS AT THE SAME LENGTH, because churn is a function of the appended
  // TEXT and not only of how much of it there is: the new boundaries are content-defined. At 2,500
  // characters the max-versus-max comparison FAILS under two ordinary-prose fillers and PASSES under a
  // hash-quiet run of one repeated character, which yields no cut at all. A test asserting it is not
  // wrong-in-one-direction; it is decided by content nobody is thinking about.
  const FILLERS = {
    "prose-a": (n) => filler(n, "z"),
    "prose-b": (n) => filler(n, "q").replace(/lorem/g, "dolorem"),
    quiet: (n) => "a".repeat(n),
    sentence: () => " a new closing paragraph appended at the very end of the document.",
  };
  for (const len of [66, 2_500, 9_000]) {
    for (const [fname, make] of Object.entries(FILLERS)) {
      if (fname === "sentence" && len !== 66) continue;
      const app = fname === "sentence" ? make() : make(len);
      let worse = 0, better = 0, tied = 0, maxCdc = 0, maxLeg = 0, worstAt = null;
      for (const { path, text } of docs) {
        const c = setChurn(chunks(text), chunks(text + app));
        const l = setChurn(legacyChunks(text), legacyChunks(text + app));
        if (c > l) {
          worse++;
          if (!worstAt || c - l > worstAt.gap) worstAt = { path, cdc: c, legacy: l, gap: c - l };
        } else if (c < l) better++;
        else tied++;
        maxCdc = Math.max(maxCdc, c);
        maxLeg = Math.max(maxLeg, l);
      }
      out.legacy[`${len}/${fname}`] = { appendLength: app.length, cdcWorse: worse, tied, cdcBetter: better, maxCdc, maxLeg, maxVsMaxPasses: maxCdc <= maxLeg, worstAt };
    }
  }

  // The exact append `test/graph-cdc.test.ts`'s `append at end` scenario applies, so the distribution
  // its `<= 1` assertion is really quantifying over is printed rather than described.
  {
    const app = " a new closing paragraph appended at the very end of the document.";
    const dist = {};
    for (const { text } of docs) {
      const c = setChurn(chunks(text), chunks(text + app));
      dist[c] = (dist[c] ?? 0) + 1;
    }
    out.fixtureAppend = { text: app, length: app.length, churnDistribution: dist };
  }

  // The one place the bound is deliberately NOT tight: appending a document to itself reproduces whole
  // chunks, and an identical chunk is never re-pushed.
  {
    const doc = filler(60_000, "b");
    const b0 = cdcBoundaries(doc, P);
    const b1 = cdcBoundaries(doc + doc, P);
    const { bound, shared } = appendBound(b0, b1);
    out.duplicateProbe = {
      case: "self-concatenation",
      shared,
      bound,
      set: setChurn(chunks(doc), chunks(doc + doc)),
      positional: positionalChurn(chunks(doc), chunks(doc + doc)),
    };
  }

  console.log(JSON.stringify(out, null, 2));
  process.exit(out.violations.length === 0 ? 0 : 1);
}

const summary = {
  revision: revision(),
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
