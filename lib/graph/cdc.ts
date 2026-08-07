/**
 * `cdc1` — content-defined chunking for graph episodes (PIPEFF-3 / AIO-826).
 *
 * WHY THIS EXISTS. The projector used to cut chunks at fixed byte offsets (`slice(i, i + 2500)`), so
 * every boundary sat a fixed distance from the start of the body and **an insertion anywhere shifted
 * every boundary after it**. Measured on a 50,000-char document: an edit in place re-extracted 1 of 20
 * chunks, an append re-extracted 1 — and a 33-char insertion near the top re-extracted all 21. On
 * 2026-08-05 that churn was ~167 of 427 episodes. A content-defined boundary is a function of the
 * characters *around* it, so an insertion perturbs the chunk it lands in and usually little else.
 *
 * THIS MODULE IS PURE — no I/O, no `Math.random`, no wall-clock, no locale-sensitive string ops. The
 * whole delta ledger rests on "same body ⇒ same chunks ⇒ same hashes", so non-determinism here is not
 * a quality issue, it is a full-corpus re-extraction (~$76) arriving silently.
 *
 * ── WHAT `cdc1` PINS ────────────────────────────────────────────────────────────────────────────
 * The config string (`cdc1-<target>-<min>-<max>-<cap>`) carries only the four numbers. Everything else
 * that determines a boundary is pinned by the NAME `cdc1`, and changing ANY of it is `cdc2`:
 *
 *   1. the unit: UTF-16 code units (`charCodeAt`), so boundary indices live in the same coordinate
 *      space `String.prototype.slice` uses (see §"the chunking unit" below);
 *   2. the two gear tables and the splitmix32 stream that generates them;
 *   3. the rolling-hash update `h = ((h << 1) + gear(c)) >>> 0`, restarted at each chunk start;
 *   4. the mask derivation — `bits = round(log2(target))`, the normalized pair at **±1** (level 1;
 *      level 2 was measured and REJECTED, see `masksFor`), the **backup mask at `bits - 6`**, and the
 *      "top-N-bits are zero" cut test;
 *   5. the surrogate-pair shift rule (+1, so `min` can never be violated).
 *
 * (Item 4 previously described a `normBits`-from-`target - min` derivation at ±2 and omitted the
 * backup mask entirely — neither of which this module ships. The fixture protected the *behaviour*,
 * but a maintainer reconstructing `cdc1` from this list would have rebuilt the wrong algorithm. Kept
 * as a note because the list is the human-readable half of the contract and its accuracy is the
 * whole point.)
 *
 * `test/graph-cdc.test.ts` checks in an expected boundary list for a fixture. That fixture is not a
 * nicety — it IS the definition of `cdc1`, and it turns a silent algorithm drift into a build failure
 * rather than a silent full-corpus re-push.
 *
 * ── THE CHUNKING UNIT ───────────────────────────────────────────────────────────────────────────
 * The rolling hash slides over UTF-16 code units and boundary indices are code-unit indices. Stated
 * explicitly because the alternative is the exact class this repo has already been bitten by (Postgres
 * `length()` counts characters while JS `.length` counts UTF-16 units): a hash rolling over bytes while
 * min/max lived in code units would put boundary indices in two different spaces.
 *
 * ── FASTCDC *NORMALIZED*, NOT A PLAIN GEAR HASH ─────────────────────────────────────────────────
 * With a single mask targeting a 2,500 average over a (1,250, 4,000] window, a plain gear hash finds no
 * boundary in ~11% of chunks and hard-cuts at the maximum. A hard cut is a *position*-defined boundary
 * — locally byte-offset-like — so runs of hash-quiet content (code blocks, tables) erode exactly the
 * insertion-locality this module exists to buy. Normalized chunking uses a HARDER mask below the target
 * and an EASIER one above it, which concentrates cuts near the target and makes max-cuts rare.
 *
 * ── AND A BACKUP BOUNDARY, BECAUSE THE MEASURED HARD-CUT RATE WAS NOT ~11% BUT ~14% ─────────────
 * Measured over this repo's own 18 markdown documents ≥15K (the closest thing to the corpus this
 * projector actually chunks), normalized chunking alone still hard-cut 14% of chunks: real documents
 * are not uniformly random, and gap-to-next-boundary is heavy-tailed (p50 ~900 chars, p90 ~4,400 in
 * `docs/ARCHITECTURE.md`, whose giant tables are hash-quiet for thousands of characters at a time).
 * Those positional cuts were the whole tail: a paragraph DELETED near the top of a document re-extracted
 * up to 12 of 20 chunks, against the spec's ≤3.
 *
 * So a third, much easier mask records a BACKUP boundary while the primary search runs, and a chunk with
 * no primary boundary is cut there rather than at `max`. The backup is still content-defined, so the
 * chunk after it realigns; a hard cut at `max` is the one boundary in this design that does not. With
 * it, hard cuts fall to ~0.3% and the delete case to ≤5 worst-case / 2 median. See the churn table in
 * `test/graph-cdc.test.ts`, which measures both algorithms side by side.
 *
 * ── WHY DELETIONS ARE THE HARD DIRECTION (and insertions are nearly free) ───────────────────────
 * The gear hash's window is ~32 code units, so the set of positions where a given mask fires is a pure
 * function of the CONTENT — alignment-independent. Alignment enters only through `min`, `target` and
 * `max`, which are measured from the chunk's start. An INSERTION pushes content to a LARGER offset
 * within its chunk, where the mask is equal or easier, so the old boundary usually still fires and the
 * next chunk realigns immediately. A DELETION pulls content to a SMALLER offset, where it can fall back
 * under `target` into the strict region and stop firing — so the boundary moves, the next chunk's start
 * moves with it, and the shift can propagate. That is the asymmetry the backup boundary bounds, and it
 * is why the delete row of the churn table is the one worth watching after any parameter change.
 */

/** A high surrogate: the first code unit of an astral-plane character. */
const isHighSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
/** A low surrogate: the second code unit of an astral-plane character. */
const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/**
 * splitmix32 — a fixed, seeded, integer-only PRNG used ONCE at module load to build the gear tables.
 *
 * Deterministic by construction: same seed ⇒ same stream on every platform and every process. This is
 * why there is no `Math.random` anywhere in this file; a randomly-seeded gear table would re-chunk the
 * entire corpus on every deploy while every unit test stayed green (each run is self-consistent).
 */
function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/**
 * Two 256-entry gear tables, indexed by the LOW and HIGH byte of a UTF-16 code unit. Two tables rather
 * than one because a single table indexed by `code & 0xff` would map every code unit sharing a low byte
 * to the same gear value — fine for ASCII, but it would flatten CJK and astral text into a near-constant
 * stream and make boundaries there effectively position-defined again.
 *
 * The seed is arbitrary but FROZEN: it is part of `cdc1`.
 */
const GEAR_SEED = 0x5eed_cdc1 >>> 0;
const { lo: GEAR_LO, hi: GEAR_HI } = (() => {
  const next = splitmix32(GEAR_SEED);
  const lo = new Uint32Array(256);
  const hi = new Uint32Array(256);
  for (let i = 0; i < 256; i++) lo[i] = next();
  for (let i = 0; i < 256; i++) hi[i] = next();
  return { lo, hi };
})();

/** The gear value for one UTF-16 code unit. Pure, total, and defined over the whole 0..65535 range. */
function gear(code: number): number {
  return (GEAR_LO[code & 0xff] ^ GEAR_HI[(code >>> 8) & 0xff]) >>> 0;
}

/** The size envelope a `cdc1` chunking runs under. All three are in UTF-16 code units. */
export interface CdcParams {
  /** Target average chunk size — the mask derivation's only input. */
  readonly target: number;
  /** Hard floor. No chunk except the final one is shorter than this. Load-bearing: see `chunkCdc`. */
  readonly min: number;
  /** Hard ceiling. A chunk with no content-defined boundary is cut here. */
  readonly max: number;
}

/** The three masks, expressed as "how many top bits of the hash must be zero" (as a right-shift). */
interface CdcMasks {
  /** Region A — below `target`. Harder (more bits), so cuts are pushed toward the target. */
  readonly shiftStrict: number;
  /** Region B — at or above `target`. Easier (fewer bits), so a cut lands soon after the target. */
  readonly shiftLoose: number;
  /** The fallback used only when NEITHER primary mask fires anywhere in [min, max). */
  readonly shiftBackup: number;
}

/**
 * A sane, ordered envelope derived from possibly-degenerate inputs.
 *
 * Normalizes rather than throwing because these numbers come from env knobs, and a projector that
 * throws on a typo'd `GRAPH_CHUNK_MIN_CHARS` stops feeding the graph entirely. Every branch here is
 * deterministic, so a misconfigured install chunks *consistently* — which is what the ledger needs.
 */
function normalizeParams(p: CdcParams): { min: number; target: number; max: number } {
  const a = Math.max(1, Math.floor(p.min));
  const b = Math.max(1, Math.floor(p.max));
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  const target = Math.min(Math.max(Math.floor(p.target), min), max);
  return { min, target, max };
}

/**
 * Mask derivation — part of `cdc1`, and every constant here was chosen against a measurement rather
 * than a textbook.
 *
 * `bits = round(log2(target))` is the textbook FastCDC base (11 at target 2,500). ±1 around it is
 * "normalization level 1". Level 2 (±2) was measured and rejected: it realizes a similar average but
 * makes the strict region 4x harder, which is exactly the region a DELETION pushes content back into —
 * the delete row of the churn table went from 5 to 12 (real docs) / 16 (synthetic).
 *
 * `bits - 6` is the backup mask. Sized so that a hash-quiet run long enough to defeat the loose mask
 * over 1,500 positions still almost always yields a backup: at 5 bits, hard cuts over this repo's own
 * markdown corpus fall from ~14% to ~0.3%. Easier masks (bits-7, bits-8 — fewer required zero bits)
 * start to make the backup itself near-positional; harder ones (bits-4, bits-3 — MORE required zero
 * bits) leave ~3% hard cuts and a worse delete tail. (An earlier version of this comment had the two
 * directions inverted: `bits-4` requires 7 zero bits against the shipped 5, which is harder, not
 * easier.)
 */
function masksFor(target: number): CdcMasks {
  const bits = Math.max(1, Math.round(Math.log2(Math.max(2, target))));
  // Clamped to a usable window: a shift of 32 is a no-op in JS (`x >>> 32 === x`), and a shift of 0
  // would make every position a boundary.
  const bitsStrict = Math.min(30, bits + 1);
  const bitsLoose = Math.max(1, bits - 1);
  const bitsBackup = Math.max(1, bits - 6);
  return { shiftStrict: 32 - bitsStrict, shiftLoose: 32 - bitsLoose, shiftBackup: 32 - bitsBackup };
}

/**
 * Nudge a boundary off the inside of a surrogate pair, deterministically.
 *
 * Direction is deliberate: the low surrogate joins the PRECEDING chunk (+1) rather than the following
 * one (-1). Shifting down could produce a chunk of `min - 1`, and the minimum is the whole reason
 * `min × MAX_EPISODE_CHUNKS ≥ 100,000` holds — it is a content-safety bound, not a tuning knob. The
 * cost is the other direction: a chunk may be `max + 1` code units in this rare case, which no
 * downstream consumer cares about (the extraction ceiling has ~60% headroom at `max`).
 */
function avoidSurrogateSplit(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  return isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end)) ? end + 1 : end;
}

/**
 * The boundary sequence for `text` under `params` — END offsets, ascending, last element `text.length`.
 *
 * ⚠️ **THE CAP IS NOT AN INPUT HERE, AND THAT IS A REQUIREMENT, NOT AN OVERSIGHT.** For a fixed body
 * under fixed `cdc1` parameters the whole boundary sequence is a deterministic function of the body
 * alone; the cap only *truncates* the emitted sequence. That is the entire basis on which
 * `chunkConfigDeltaCompatible` may return true for a CDC cap-GROW: chunks 0..79 are byte-identical
 * under cap 80 and cap 120. A tempting implementation special-cases the final permitted chunk
 * (absorbing the remainder, or cutting it differently because it knows it is last) — any such case
 * breaks prefix stability at exactly chunk `cap−1`. Pinned by test.
 *
 * Shape of each iteration:
 *   - a remainder of `min` or fewer becomes the final chunk outright (so a short tail is never split);
 *   - otherwise the hash is restarted at the chunk start and rolled forward, TESTING for a cut only
 *     once `min` code units have been consumed. Rolling (rather than skipping) over the min region is
 *     part of `cdc1`: it warms the window, so the first tested positions have full entropy instead of
 *     depending on three characters. (It is also why the hash restart is nearly free of consequence:
 *     the gear hash's window is ~32 code units, far inside `min`.)
 *   - a BACKUP boundary is recorded along the way and used if the primary masks never fire. Preference
 *     order is deliberate: the first backup hit at or after `target` if there is one, otherwise the
 *     first backup hit at all — so the fallback lands near the target rather than immediately after
 *     `min`, and never at a purely positional `max`.
 */
export function cdcBoundaries(text: string, params: CdcParams): number[] {
  const { min, target, max } = normalizeParams(params);
  const { shiftStrict, shiftLoose, shiftBackup } = masksFor(target);
  const n = text.length;
  const ends: number[] = [];
  let start = 0;
  while (start < n) {
    if (n - start <= min) {
      ends.push(n);
      break;
    }
    const hardEnd = Math.min(start + max, n);
    const firstTestable = start + min; // the earliest END offset a cut may take
    const looseFrom = start + target; // where region A becomes region B
    let h = 0;
    let cut = -1;
    let backup = -1;
    for (let i = start; i < hardEnd; i++) {
      h = ((h << 1) + gear(text.charCodeAt(i))) >>> 0;
      const end = i + 1; // a cut AFTER position i
      if (end < firstTestable) continue;
      const shift = end < looseFrom ? shiftStrict : shiftLoose;
      if (h >>> shift === 0) {
        cut = end;
        break;
      }
      if (h >>> shiftBackup === 0 && (backup < 0 || (backup < looseFrom && end >= looseFrom))) backup = end;
    }
    const chosen = cut > 0 ? cut : backup > 0 ? backup : hardEnd;
    const end = avoidSurrogateSplit(text, chosen);
    // Unreachable by construction (`end > start` always, since `hardEnd > start`), kept so a future
    // parameter change can never turn this into an infinite loop that hangs the projector.
    ends.push(end > start ? end : n);
    start = ends[ends.length - 1];
  }
  return ends;
}

/**
 * Split `text` into at most `cap` content-defined chunks. Whitespace-only ⇒ `[]` (nothing to extract),
 * matching the legacy chunker exactly — the battery's SQL blank predicate and the projector's
 * "nothing to project" branch both depend on that agreement.
 *
 * Truncation-only: the chunks are `cdcBoundaries(...).slice(0, cap)` and nothing about the cap reaches
 * the boundary computation. Content past the cap is dropped, which is why `min × cap` is the real
 * guarantee about how much of a large document reaches the graph.
 */
export function chunkCdc(text: string, params: CdcParams, cap: number): string[] {
  const body = text ?? "";
  if (!body.trim()) return [];
  const limit = Math.max(1, Math.floor(cap));
  const ends = cdcBoundaries(body, params);
  const chunks: string[] = [];
  let start = 0;
  for (const end of ends) {
    if (chunks.length >= limit) break;
    chunks.push(body.slice(start, end));
    start = end;
  }
  return chunks;
}
