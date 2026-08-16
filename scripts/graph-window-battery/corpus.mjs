/**
 * The battery's corpus selection (PIPEFF-2 / AIO-821).
 *
 * WHY THE RULE IS FIXED IN ADVANCE AND THE CONTENT IS NOT CHECKED IN.
 *
 * EXMODEL-1 failed exactly here. This repo is public, so a checked-in fixture had to be synthetic —
 * and two synthetic attempts scored the NEGATIVE CONTROL (the model that actually polluted the
 * graph) as a pass, and the good model as a fail. Wrong in both directions. A third iteration would
 * have been tuning the fixture until it agreed with the conclusion.
 *
 * So there is no fixture. The battery reads this install's own `items` at run time and chunks them
 * with the projector's own algorithm. What IS fixed in advance — here, in code, before any run — is
 * the SELECTION RULE, so the corpus cannot be hand-picked toward a result. The chosen item ids are
 * pinned in the report so a later session is comparable rather than merely similar.
 *
 * ── THE BUCKETS PARTITION BY CHUNK COUNT ─────────────────────────────────────────────────────────
 *
 * Not a taste decision: the lever's whole thesis is that the ten predecessors behave differently by
 * item shape (a single-chunk item's are all unrelated; a multi-chunk item's are its own document),
 * so the corpus has to represent both, in a mix close to prod's.
 *
 * Two drafts of the spec left a HOLE here, and each hole was found by review rather than by running:
 *   · draft 1: buckets "≥8 chunks" / "<600 chars" / "1-3 chunks" — 4-7-chunk items fell in none;
 *   · draft 2: "≥8" / "1 chunk AND <600 chars" / "2-7" — a 1-chunk item of 600-2,500 chars fell in
 *     none.
 * Hence `bucketOf` is total over every chunk count ≥ 1, and a unit test asserts that directly.
 */

/**
 * An extensionally-equivalent replica of `resolvePositiveInt` from `lib/util/env` — pinned by test,
 * not by assertion, which the projector uses for
 * these same two knobs. A .mjs script cannot import the TypeScript, so the logic is duplicated — and
 * a unit test pins the two against each other across the cases where a loose parse diverges
 * (`"0.5"`, `"Infinity"`, `""`, `"abc"`, `"-5"`).
 *
 * The loose version this replaced (`Number(x) > 0 ? Number(x) : d`) disagreed on exactly those:
 * `GRAPH_CHUNK_CHARS=0.5` would have had the battery chunk at 0.5 chars while the projector chunked
 * at 2,500 — a silent, total mis-count of the corpus.
 */
function resolvePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  return floored > 0 ? floored : fallback;
}

/** Mirrors the LEGACY byte-offset chunker in lib/graph/project.ts, at the cap PIPEFF-2's sessions were
 *  pre-registered against (40). A divergence here silently mis-buckets the whole corpus, so the
 *  runner must print both values in its report rather than leaving them implicit.
 *
 *  ⚠️ PIPEFF-3 moved the projector to content-defined chunking (`cdc1`), whose chunk count is NOT a
 *  function of `length(body)` and so cannot be re-derived in SQL at all — which is what this file
 *  exists to do. The estimate is therefore deliberately still the legacy one (pinned against
 *  `chunkContentLegacy` by test/graph-window-battery-corpus.test.ts), and it now UNDER-counts by ~5%
 *  because CDC realizes a ~2,630 average rather than a flat 2,500. A future battery run that needs
 *  episode-exact selection must go through `verifyCorpus` with the projector's real `chunkContent`
 *  — the escape hatch that already exists for the UTF-16 divergence. */
export const CHUNK_CHARS = resolvePositiveInt(process.env.GRAPH_CHUNK_CHARS, 2500);
export const MAX_EPISODE_CHUNKS = resolvePositiveInt(process.env.GRAPH_MAX_EPISODE_CHUNKS, 40);
export { resolvePositiveInt };

/** The small-item threshold. 898 of 2,267 items (40%) sit under this and each occupies a whole
 *  episode at full fixed-overhead price — the population B1 exists to represent. */
export const SMALL_ITEM_CHARS = 600;

/**
 * How many episodes an item becomes, by the LEGACY chunker's rule: whitespace-only → none, otherwise
 * ceil(chars / CHUNK_CHARS) capped at MAX_EPISODE_CHUNKS.
 *
 * Derived from `chunkContentLegacy`'s algorithm rather than by calling it, because the battery selects
 * from a SQL projection of `length(body)` over thousands of rows and never needs the bodies to
 * count. The equivalence is unit-tested against `chunkContentLegacy` itself. See the ⚠️ on
 * `CHUNK_CHARS` above for why this is the legacy algorithm and what that now costs.
 */
export function chunkCount(chars, blank = false) {
  if (blank || chars <= 0) return 0;
  return Math.min(Math.ceil(chars / CHUNK_CHARS), MAX_EPISODE_CHUNKS);
}

/**
 * Which bucket an item belongs to. TOTAL over every chunk count ≥ 1 — see the header.
 * A zero-chunk (whitespace-only) item is `null`: the projector skips it upstream, so it is not a
 * hole in the partition, it is not an item the graph ever sees.
 */
/**
 * Episode count for a body already in memory, using the JS string length — which is what the chunker
 * slices by, and is exactly the number Postgres `length()` cannot give (it counts characters, not
 * UTF-16 units). For plain-node callers that cannot import the TypeScript.
 * Equivalent to `chunkContentLegacy(body).length`, pinned by unit test.
 */
export const countFromBody = (body) => chunkCount((body ?? "").length, !(body ?? "").trim());

export function bucketOf(chunks, chars) {
  if (chunks <= 0) return null;
  if (chunks >= 8) return "A"; // multi-chunk: the coreference case the lever must not break
  if (chunks === 1) return chars < SMALL_ITEM_CHARS ? "B1" : "B2"; // the 40% tail, and the rest of the single-chunk population
  return "C"; // 2-7 chunks
}

/**
 * How many items of each bucket the corpus takes, most recent first.
 *
 * ── WHY `A` IS 3 AND NOT 5 — a pre-registration amendment, recorded before any session ran ───────
 *
 * The spec sized the corpus at ~100 episodes and DERIVED Q5's band from that: at ~100 episodes one
 * validation retry moves the signed gap by ~1pp, so a 1.5pp validity ceiling tolerates exactly one
 * retry of rep-to-rep difference and not two. That derivation is the only reason Q5's band is 3pp.
 *
 * Run against this install, `A: 5` selected 9, 8, 40, 23 and 22-chunk items — 102 episodes in bucket
 * A alone, 153 in total. At 153 episodes one retry is 0.65pp, so the SAME pre-registered 1.5pp
 * ceiling would silently tolerate 2.3 retries. The number would not have changed; what it MEANT
 * would have. That is the quiet kind of drift this whole workstream is about.
 *
 * So the corpus size is fixed to keep the coupling, rather than the band re-derived after seeing a
 * corpus: `A: 3` yields 57 + 15 + 5 + 31 = 108 episodes, where one retry is 0.93pp. It also moves the
 * single-chunk episode share from 13.1% to ~18.5%, CLOSER to prod's ~17% — which matters because C1
 * is corpus-mix-sensitive.
 *
 * If a future draw lands materially outside ~100-120 episodes, Q5's band must be re-derived in a
 * committed amendment BEFORE that session runs. `selectCorpus` reports `episodes` so this is
 * checkable rather than assumed.
 */
export const BUCKET_TARGETS = Object.freeze({ A: 4, B1: 10, B2: 6, C: 8 });

/**
 * AMENDMENT, PIPEFF-5, 2026-08-16: exclude single items larger than this from selection.
 *
 * Under the legacy chunker a bucket-A item was ~8–15 episodes. Under `cdc1` the most recent
 * A-candidate is **80 episodes** — two thirds of the entire 90–120 budget in ONE document. With that
 * item in, the budget and prod's ~17% single-chunk share became mutually unsatisfiable: the only
 * feasible draw with all four buckets represented was 120 episodes at a 9.2% single-chunk share,
 * which fails the mix-match that makes C1 transferable at all.
 *
 * Excluding it restores both — A:3/B1:10/B2:6/C:8 yields **94 episodes at 17.0%**, and the A and C
 * targets are unchanged from the PIPEFF-2 rule. B1 15→10 and B2 5→6 are the only target moves.
 *
 * WHAT THIS COSTS, stated rather than discovered: the battery does **not** cover documents above the
 * cap. Prod has them. The claim being bought is that one document must not be two thirds of a
 * measurement whose whole purpose is a blended per-episode figure — with 8 reps, its variance would
 * swamp every other item. A future run that wants the very-large-document case needs its own draw
 * and its own budget, not this one silently stretched.
 */
export const MAX_ITEM_EPISODES = resolvePositiveInt(process.env.GWB_MAX_ITEM_EPISODES, 30);

/** The episode range Q5's pre-registered band was derived at. Outside it, the band is not valid. */
export const EPISODE_BUDGET = Object.freeze({ min: 90, max: 120 });

/**
 * Pick the corpus from candidate rows, newest first within each bucket.
 *
 * `rows` must already be ordered newest-first and restricted to `access='team'` and the projectable
 * kinds — the tier restriction is what makes the whole corpus land in ONE Graphiti group by
 * SELECTION rather than by bypassing the projector, which is how the spec avoids a bespoke pusher.
 *
 * Pure and deterministic given `rows`: same input, same corpus. That is what makes "pinned item ids"
 * a meaningful claim rather than a hopeful one.
 */
export function selectCorpus(rows, targets = BUCKET_TARGETS) {
  const picked = { A: [], B1: [], B2: [], C: [] };
  for (const r of rows) {
    // PIPEFF-5: a row may carry `chunks` measured by the projector's REAL chunker
    // (`count-chunks.ts`). Prefer it. The `chunkCount(chars)` estimate below was exact under the
    // legacy byte-offset chunker and is not under `cdc1` — on the 2026-08-16 draw it said 117 while
    // the projector pushed 164, a 40% under-count. Every consumer of this function is affected:
    // `bucketOf` mis-files items (bucket A is "≥8 chunks" and was being decided on a guess), and
    // `episodeBudgetBreach` was passing a corpus 44 episodes outside its own range.
    const n = Number.isFinite(r.chunks) ? r.chunks : chunkCount(r.chars, r.blank);
    // One document must not be most of the corpus — see MAX_ITEM_EPISODES.
    if (n > MAX_ITEM_EPISODES) continue;
    const b = bucketOf(n, r.chars);
    if (!b) continue;
    if (picked[b].length >= targets[b]) continue;
    picked[b].push({ ...r, chunks: n, bucket: b });
  }
  const items = [...picked.A, ...picked.B1, ...picked.B2, ...picked.C];
  const episodes = items.reduce((s, i) => s + i.chunks, 0);
  const singleChunkEpisodes = items.filter((i) => i.chunks === 1).length;
  return {
    items,
    byBucket: picked,
    episodes,
    // Reported because C1 is corpus-mix-sensitive: prod's single-chunk share is ~17% (898 of 5,166
    // episodes), and a blended tokens-per-episode figure only transfers if the mix is close.
    singleChunkEpisodeShare: episodes > 0 ? singleChunkEpisodes / episodes : 0,
    shortfall: Object.entries(targets)
      .filter(([b, want]) => picked[b].length < want)
      .map(([b, want]) => `${b}: wanted ${want}, found ${picked[b].length}`),
    // Q5's band was derived at ~100 episodes (one retry ≈ 1pp). Outside this range the band's
    // MEANING changes without its number changing, so the runner must refuse rather than proceed.
    episodeBudgetBreach:
      episodes < EPISODE_BUDGET.min || episodes > EPISODE_BUDGET.max
        ? `${episodes} episodes is outside the ${EPISODE_BUDGET.min}-${EPISODE_BUDGET.max} range Q5's band was derived at — re-derive it in a committed amendment first`
        : null,
    /** True when every row carried a real measured count, so the numbers above are exact, not estimated. */
    countedExactly: rows.length > 0 && rows.every((r) => Number.isFinite(r.chunks)),
  };
}

/**
 * The SQL the battery runs against a read-only prod connection. Kept here beside the rule so the two
 * cannot drift; `length(body)` rather than `body` so selection never pulls content it does not need.
 */
/**
 * "This body yields no episodes", in SQL, matching `chunkContent`'s `!text.trim()`.
 *
 * NOT `btrim(body) = ''`: Postgres `btrim/1` strips **spaces only**, so `btrim(E'  \n\t  ')` is
 * `E'\n\t'`, not `''` — verified on the test database. A newline/tab-only body would have been
 * counted as a 1-episode item the projector then emits ZERO episodes for, diverging the counted and
 * pushed totals, wasting a B1 slot, and skewing the single-chunk share.
 */
export const blankBodySql = (alias = "body") => `${alias} ~ '^\\s*$'`;

export const CANDIDATE_SQL = `
  select id, path, kind, work_at,
         length(body) as chars,
         (${blankBodySql()}) as blank
    from items
   where team_id = $1
     and access = 'team'
     and kind = any($2)
   order by work_at desc, id
   limit 2000
`;

/** The projectable kinds, mirrored from lib/graph/project.ts PROJECTABLE_KINDS (pinned by test). */
export const PROJECTABLE_KINDS = ["transcript", "deliverable", "decision", "task", "artifact"];

/**
 * Recompute the SELECTED corpus's episode counts with the projector's REAL `chunkContent`.
 *
 * `chunkCount` estimates from Postgres `length(body)`, which counts CHARACTERS while the chunker
 * slices by JS string index, i.e. UTF-16 units — `length('👍👍')` is 2 in Postgres and 4 in JS. A body
 * with astral characters near a chunk boundary therefore estimates low, which would mis-bucket at
 * the A/C and B2/C edges and, worse, run the `EPISODE_BUDGET` check (the thing keeping Q5's band
 * meaningful) on an undercount.
 *
 * The estimate is still right for SELECTION — it runs over ~2,000 rows and a boundary item landing
 * in the neighbouring bucket is a minor sampling effect. But the ~31 selected items are few enough
 * to chunk for real, so the number that actually matters is exact rather than derived.
 *
 * `countFn` is injected rather than hardcoded. Callers that can load the TypeScript (the tests) pass
 * the projector's own `chunkContent` directly; a plain-node caller passes `countFromBody` below,
 * which is the legacy algorithm over the same input and is pinned against `chunkContentLegacy` by
 * unit test.
 */
export function verifyCorpus(selection, bodyById, countFn) {
  const items = selection.items.map((it) => {
    const body = bodyById.get(it.id);
    if (body === undefined) throw new Error(`verifyCorpus: no body supplied for ${it.id}`);
    const chunks = countFn(body);
    // Re-bucket on the TRUE count too. Returning verified `items` beside an estimated `byBucket`
    // would hand a reader stale numbers while looking verified — and Q4's population is spec'd as
    // "buckets A + C", so a truly-2-chunk item estimated at 1 would sit in B2 and be silently
    // excluded from the very metric that measures cross-chunk continuity.
    return { ...it, estimatedChunks: it.chunks, chunks, bucket: bucketOf(chunks, it.chars) ?? it.bucket };
  });
  const episodes = items.reduce((s, i) => s + i.chunks, 0);
  const single = items.filter((i) => i.chunks === 1).length;
  const divergent = items.filter((i) => i.chunks !== i.estimatedChunks);
  const byBucket = { A: [], B1: [], B2: [], C: [] };
  for (const it of items) if (byBucket[it.bucket]) byBucket[it.bucket].push(it);

  return {
    ...selection,
    items,
    byBucket,
    shortfall: Object.entries(BUCKET_TARGETS)
      .filter(([b, want]) => byBucket[b].length < want)
      .map(([b, want]) => `${b}: wanted ${want}, found ${byBucket[b].length}`),
    episodes,
    singleChunkEpisodeShare: episodes > 0 ? single / episodes : 0,
    // Surfaced, never swallowed: a divergence means the SQL estimate and the projector disagree, and
    // the runner should say so rather than quietly using whichever number it holds.
    divergent: divergent.map((i) => ({ id: i.id, estimated: i.estimatedChunks, actual: i.chunks })),
    episodeBudgetBreach:
      episodes < EPISODE_BUDGET.min || episodes > EPISODE_BUDGET.max
        ? `${episodes} episodes is outside the ${EPISODE_BUDGET.min}-${EPISODE_BUDGET.max} range Q5's band was derived at — re-derive it in a committed amendment first`
        : null,
  };
}
