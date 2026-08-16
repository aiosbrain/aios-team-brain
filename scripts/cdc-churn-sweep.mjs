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
const refuse = (why) => {
  console.error(`cdc-churn-sweep: REFUSING — ${why}`);
  process.exit(2);
};
/**
 * `flag()` used to take the NEXT token unconditionally, so `--op --exclude foo.md` set `op` to
 * `"--exclude"`, fell through to in-place mode, and exited 0 — a quietly wrong run that looks like a
 * measurement. Every degraded-input path in this file now refuses instead, because the one thing this
 * script exists to be is a number you can trust.
 */
const flag = (name, fallback) => {
  const i = ARGV.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = ARGV[i + 1];
  if (value === undefined || value.startsWith("--")) refuse(`--${name} needs a value`);
  return value;
};
const OP = flag("op", "inplace");
if (OP !== "inplace" && OP !== "append") refuse(`unknown --op ${OP} (expected inplace or append)`);
/**
 * The design documents ARE the corpus, so a document that publishes a distribution is inside it —
 * and so is a document that DESCRIBES the distribution. Both of this ticket's design files are in the
 * measured set (`cdc-append-churn.md` at ~29k characters, `content-defined-chunking.md` at ~25k), which
 * is not a hypothetical: an earlier commit on this branch quoted figures that its own next commit moved,
 * twice, by editing the second file. Comma-separated, honoured in BOTH modes, and it REFUSES when a
 * named path matches nothing — a typo'd exclusion silently publishing the unexcluded numbers is the
 * same failure wearing a different hat.
 */
const EXCLUDE = flag("exclude", "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);
const STEP = Number(flag("step", ARGV.find((a) => /^\d+$/.test(a)) ?? 97));
// A non-numeric --step produced NaN and a 10-sample "sweep"; --step 0 hung the in-place loop forever.
if (!Number.isInteger(STEP) || STEP < 1) refuse(`--step must be a positive integer, got ${flag("step", "")}`);

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
  // `EXCLUDE` is applied HERE rather than at each call site, so neither mode can forget it.
  const matched = new Set();
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
      if (text.length < minLength) continue;
      if (EXCLUDE.includes(path)) {
        matched.add(path);
        continue;
      }
      out.push({ path, text });
    }
  }
  const missed = EXCLUDE.filter((p) => !matched.has(p));
  if (missed.length) refuse(`--exclude named ${missed.join(", ")}, which is not in this corpus`);
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
 * THE BOUND, IN THE COORDINATES THE COST IS PAID IN. `L` = the length of the common prefix of the two
 * ADMITTED CHUNK ARRAYS. Those chunks are byte-identical AND present in the before-set, so none of them
 * can be re-pushed; at most the chunks after `L` can be. A theorem with no preconditions.
 *
 * IT WAS FIRST WRITTEN OVER THE BOUNDARY SEQUENCES, AND THAT VERSION IS FALSE. Both spec reviewers
 * produced the same counter-example: `chunkCdc` returns `[]` for a whitespace-only body (cdc.ts:271)
 * while `cdcBoundaries` still returns boundaries, so a whitespace base has `L > 0` over boundaries and
 * an EMPTY before-set — 20,000 spaces plus one `x` churns 6 against a boundary-bound of 1. The
 * boundary form also mis-stated the cap case (see `capParity` below). Both are reported here so the
 * refutation reproduces rather than being asserted.
 */
const appendBound = (c0, c1) => {
  let l = 0;
  while (l < c0.length && l < c1.length && c0[l] === c1[l]) l++;
  return { shared: l, bound: Math.max(0, c1.length - l) };
};
/** The FALSIFIED boundary-coordinate form, kept runnable so its counter-examples reproduce. */
const boundaryFormBound = (b0, b1) => {
  let l = 0;
  while (l < b0.length && l < b1.length && b0[l] === b1[l]) l++;
  return { shared: l, bound: Math.max(0, Math.min(CAP, b1.length) - l) };
};

/**
 * THE ABSOLUTE GUARD — the one assertion here that cannot self-adjust.
 *
 * The bound above is computed from the chunker's own output, so ANY prefix-stable chunker satisfies it:
 * a regression that re-cuts deeply just shrinks `L` and inflates the bound to match (Fable's review).
 * This ceiling is derived from the SIZE ENVELOPE instead — configuration, not behaviour:
 *
 *   • only boundaries whose chunk start lies within `max` of the old end can move (cdc.ts:222), and
 *     non-final chunks are at least `min`, so at most `1 + floor((max-1)/min)` of them are in play;
 *   • the appended text of length A adds at most `ceil(A/min)` further chunks.
 */
const DEPTH_CEILING = 1 + Math.floor((P.max - 1) / P.min);
const absoluteCeiling = (appendLength) => DEPTH_CEILING + Math.ceil(appendLength / P.min);

if (OP === "append") {
  const which = flag("corpus", "test");
  // The design documents ARE the corpus, so the spec quoting these numbers is IN them and every edit to
  // it moves them (both reviewers caught a table that had already gone stale that way). `--exclude`
  // makes a published distribution stable against the document that publishes it.
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
    excluded: EXCLUDE.length ? EXCLUDE : null,
    depthCeiling: { provable: DEPTH_CEILING, derivation: "1 + floor((max-1)/min)", observed: 0, violations: 0 },
    absoluteGuard: { formula: "depthCeiling + ceil(appendLength/min)", violations: [], synthetic: null },
    boundaryFormViolations: [],
    capParity: [],
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
      const { shared, bound } = appendBound(base, after);
      const bf = boundaryFormBound(b0, b1);
      const s = setChurn(base, after);
      const p = positionalChurn(base, after);
      out.samples++;
      if (s <= bound) out.boundHolds++;
      else out.violations.push({ path, len, filler: fname, bound, set: s, shared });
      if (s === bound) out.boundTightSet++;
      else if (s < bound) out.slack.push({ path, len, filler: fname, bound, set: s, positional: p });
      if (p === bound) out.boundTightPositional++;
      if (s > bf.bound) out.boundaryFormViolations.push({ path, len, filler: fname, boundaryBound: bf.bound, set: s });
      if (s > absoluteCeiling(len))
        out.absoluteGuard.violations.push({ path, len, filler: fname, ceiling: absoluteCeiling(len), set: s });
      // The cap case, measured rather than asserted: a document PAST the cap is not automatically 0.
      if (b0.length >= CAP) out.capParity.push({ path, len, filler: fname, boundaries: b0.length, sharedBoundaries: bf.shared, set: s });
      const depth = b0.length - bf.shared;
      if (depth > out.depthCeiling.observed) out.depthCeiling.observed = depth;
      if (depth > DEPTH_CEILING) out.depthCeiling.violations++;
      out.depthHistogram[depth] = (out.depthHistogram[depth] ?? 0) + 1;
      // Structural claim: a boundary whose chunk START sits at least `max` before the original end is
      // computed from unchanged input and cannot move.
      const lastSharedEnd = bf.shared > 0 ? b0[bf.shared - 1] : 0;
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
    // Replace BEFORE slicing. Doing it after made this filler 2,602 characters at a nominal 2,500, so
    // the "flips with content at a FIXED length" claim it was evidence for was length-confounded.
    "prose-b": (n) => filler(n + 512, "q").replace(/lorem/g, "dolorem").slice(0, n),
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

  // The absolute guard on SYNTHETIC documents too. 28 real files are not evidence about an algorithm,
  // and this is the one assertion the test gates on that is meant to hold for any input, not for this
  // corpus — so its sample count has to come from here rather than from a throwaway.
  {
    let samples = 0, violations = 0, maxDepth = 0, boundViolations = 0, worst = null;
    for (let seed = 1; seed <= 400; seed++) {
      const doc = filler(2_000 + ((seed * 911) % 80_000), `g${seed}-`);
      const c0 = chunks(doc), b0 = cdcBoundaries(doc, P);
      for (const len of [1, 66, 700, 1_249, 2_500, 9_000, 40_000])
        for (const app of [filler(len, `h${seed}-`), "a".repeat(len), " ".repeat(len)]) {
          const c1 = chunks(doc + app), b1 = cdcBoundaries(doc + app, P);
          const s2 = setChurn(c0, c1);
          samples++;
          if (s2 > appendBound(c0, c1).bound) boundViolations++;
          if (s2 > absoluteCeiling(app.length)) { violations++; worst = { seed, len, set: s2, ceiling: absoluteCeiling(app.length) }; }
          const d = b0.length - boundaryFormBound(b0, b1).shared;
          if (d > maxDepth) maxDepth = d;
        }
    }
    out.absoluteGuard.synthetic = { documents: 400, samples, violations, worst, boundViolations, maxDepthObserved: maxDepth };
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

  // THE MERGE EVENT — an append that DELETES a boundary, via the backup-mask preference rule. Probed
  // rather than described: the spec first claimed "appending one character" does this, and both
  // reviewers showed it is character-dependent (`q` yes, `x` no) and that the sweep never observed it.
  {
    const target = "docs/design/work-timeline-context-layer.md";
    const doc = docs.find((d) => d.path === target);
    out.mergeProbe = doc
      ? (() => {
          const b0 = cdcBoundaries(doc.text, P);
          const deletes = [];
          const keeps = [];
          for (const ch of ["q", "x", "a", "z", " ", ".", "%", "5", "\n"]) {
            const b1 = cdcBoundaries(doc.text + ch, P);
            (b1.length < b0.length ? deletes : keeps).push(ch);
          }
          const ch = deletes[0];
          if (ch === undefined) return { path: target, boundariesBefore: b0.length, deletes, keeps, note: "no single character deletes a boundary here any more" };
          const b1 = cdcBoundaries(doc.text + ch, P);
          const gone = b0.filter((e) => e !== doc.text.length && !b1.includes(e));
          return {
            path: target, boundariesBefore: b0.length, boundariesAfter: b1.length,
            deletes, keeps, character: ch, vanishedBoundaries: gone,
            churn: setChurn(chunks(doc.text), chunks(doc.text + ch)),
            bound: appendBound(chunks(doc.text), chunks(doc.text + ch)).bound,
          };
        })()
      : { path: target, note: "not in this corpus any more — the witness is live content and may rot" };
  }

  // THE CAP CASE, CONSTRUCTED. The first draft said a document past the cap churns 0. False: what has to
  // reach the cap is the SHARED CHUNK PREFIX, not the boundary count, and an append can move the last
  // two boundaries. Built here so the refutation is reproducible rather than a claim about one file.
  {
    const big = filler(400_000, "c");
    out.capProbe = [];
    for (const want of [79, 80, 81, 82]) {
      let lo = 1_000, hi = 400_000, found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const n = cdcBoundaries(big.slice(0, mid), P).length;
        if (n === want) { found = mid; break; }
        if (n < want) lo = mid + 1; else hi = mid - 1;
      }
      if (found === null) { out.capProbe.push({ boundaries: want, note: "no prefix realises that count" }); continue; }
      const doc = big.slice(0, found);
      for (const len of [66, 2_500]) {
        const app = filler(len, "d");
        const c0 = chunks(doc), c1 = chunks(doc + app);
        const { shared, bound } = appendBound(c0, c1);
        out.capProbe.push({ boundaries: want, appendLength: len, sharedChunks: shared, bound, set: setChurn(c0, c1) });
      }
    }
  }

  // Does appending an existing chunk VERBATIM save anything? The spec claims not — the boundary shift
  // means the re-cut chunks are not byte-identical to the original. Probed, not asserted.
  {
    const doc = filler(60_000, "v");
    const c0 = chunks(doc);
    const c1 = chunks(doc + c0[5]);
    out.verbatimChunkProbe = { appended: "chunk 5, verbatim", bound: appendBound(c0, c1).bound, set: setChurn(c0, c1) };
  }

  // The cross-algorithm envelope that REPLACES the deleted max-versus-max comparison: per document, how
  // much worse than byte offsets can CDC be? Reported by regime, because it is +1 for appends shorter
  // than `min` and larger for long ones on synthetic documents (measured +2 here — an earlier version of
  // this comment said +4, a figure from a throwaway generator that this script never produced).
  {
    let shortMax = -Infinity, longMax = -Infinity, shortAt = null, longAt = null;
    for (const { path, text } of docs)
      for (const len of APPEND_LENGTHS)
        for (const [fname, make] of Object.entries(BOUND_FILLERS)) {
          const app = make(len);
          const gap = setChurn(chunks(text), chunks(text + app)) - setChurn(legacyChunks(text), legacyChunks(text + app));
          if (len < P.min) { if (gap > shortMax) { shortMax = gap; shortAt = { path, len, filler: fname, gap }; } }
          else if (gap > longMax) { longMax = gap; longAt = { path, len, filler: fname, gap }; }
        }
    // …and the same question on SYNTHETIC documents, because a corpus of 28 real files is not evidence
    // about the algorithm. Both populations stay at +1 for appends shorter than `min`; the LONG regime is
    // where they diverge, which is why the gate is scoped to the short one rather than stated generally.
    let synShort = -Infinity, synShortAt = null, synLong = -Infinity, synLongAt = null;
    for (let seed = 1; seed <= 300; seed++) {
      const doc = filler(2_000 + ((seed * 911) % 80_000), `s${seed}-`);
      for (const len of [1, 66, 700, 1_249, 2_500, 9_000, 40_000]) {
        const app = filler(len, `t${seed}-`);
        const gap = setChurn(chunks(doc), chunks(doc + app)) - setChurn(legacyChunks(doc), legacyChunks(doc + app));
        if (len < P.min) { if (gap > synShort) { synShort = gap; synShortAt = { seed, len, gap, docLength: doc.length }; } }
        else if (gap > synLong) { synLong = gap; synLongAt = { seed, len, gap, docLength: doc.length }; }
      }
    }
    out.legacyEnvelope = {
      corpus: { shortAppendMaxGap: shortMax, shortAt, longAppendMaxGap: longMax, longAt },
      synthetic: { documents: 300, shortAppendMaxGap: synShort, shortAt: synShortAt, longAppendMaxGap: synLong, longAt: synLongAt },
    };
  }

  // The one place the bound is deliberately NOT tight: appending a document to itself reproduces whole
  // chunks, and an identical chunk is never re-pushed.
  {
    const doc = filler(60_000, "b");
    const b0 = cdcBoundaries(doc, P);
    const b1 = cdcBoundaries(doc + doc, P);
    const c0 = chunks(doc), c1 = chunks(doc + doc);
    const { bound, shared } = appendBound(c0, c1);
    out.duplicateProbe = {
      case: "self-concatenation",
      sharedChunks: shared,
      boundaryCounts: [b0.length, b1.length],
      bound,
      set: setChurn(c0, c1),
      positional: positionalChurn(c0, c1),
    };
  }

  /**
   * WHAT MAKES THIS EXIT NON-ZERO — and the three ways it used to fail OPEN, all found in review.
   *
   *  1. an EMPTY corpus exited 0 with zero evidence: `corpus()` swallows a `readdirSync` failure, so a
   *     wrong cwd made every invariant vacuously green. There is a sample floor now.
   *  2. the synthetic leg's DEPTH was computed and reported but never counted, so a chunker that broke
   *     the derived ceiling on synthetic documents while the corpus stayed at 2 exited 0.
   *  3. the probes had no expectations at all — `duplicateProbe` could report set === bound (the rule
   *     silently becoming an equality again) and nothing noticed.
   *
   * Probe ROT is deliberately NOT a failure: the merge witness is live content and the spec says it is
   * expected to rot. It is a `warning`, which is a different thing from a refuted invariant, and saying
   * so is why the spec no longer claims this exits non-zero on "any" of them.
   */
  const expectations = [];
  const expect = (name, ok, detail) => { if (!ok) expectations.push({ name, detail }); };
  expect("corpus is non-empty", out.corpus.docs > 5, { docs: out.corpus.docs });
  expect("samples were taken", out.samples > 0, { samples: out.samples });
  expect("synthetic leg ran", (out.absoluteGuard.synthetic?.samples ?? 0) > 0, out.absoluteGuard.synthetic);
  expect(
    "synthetic divergence depth is within the derived ceiling",
    (out.absoluteGuard.synthetic?.maxDepthObserved ?? Infinity) <= DEPTH_CEILING,
    out.absoluteGuard.synthetic
  );
  // The rule is an INEQUALITY; this probe is the only thing that shows it, so it going tight is a defect.
  expect("duplicate content costs strictly less than the bound", out.duplicateProbe.set < out.duplicateProbe.bound, out.duplicateProbe);
  expect("a verbatim duplicate chunk saves nothing", out.verbatimChunkProbe.set === out.verbatimChunkProbe.bound, out.verbatimChunkProbe);
  // The cap claim, checked rather than described: a shared prefix AT the cap must cost nothing.
  for (const row of out.capProbe)
    if (row.sharedChunks !== undefined)
      expect("shared prefix at the cap costs nothing", row.sharedChunks >= CAP ? row.set === 0 : true, row);
  out.expectationsFailed = expectations;
  out.warnings = [];
  if (out.mergeProbe?.note) out.warnings.push({ probe: "mergeProbe", note: out.mergeProbe.note });
  if (out.capProbe.some((r) => r.note)) out.warnings.push({ probe: "capProbe", note: "a boundary count had no realising prefix" });

  console.log(JSON.stringify(out, null, 2));
  const failed =
    out.violations.length +
    out.absoluteGuard.violations.length +
    out.depthCeiling.violations +
    (out.absoluteGuard.synthetic?.violations ?? 0) +
    (out.absoluteGuard.synthetic?.boundViolations ?? 0) +
    expectations.length;
  process.exit(failed === 0 ? 0 : 1);
}

const summary = {
  revision: revision(),
  excluded: EXCLUDE.length ? EXCLUDE : null,
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
