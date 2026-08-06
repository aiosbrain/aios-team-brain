import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs script, no types; imported for its pure selection rule.
import { bucketOf, chunkCount, selectCorpus, BUCKET_TARGETS, SMALL_ITEM_CHARS, MAX_EPISODE_CHUNKS, EPISODE_BUDGET } from "../scripts/graph-window-battery/corpus.mjs";
import { chunkContent } from "../lib/graph/project";

/**
 * The battery's corpus selection for PIPEFF-2 (AIO-821).
 *
 * Spec-derived. Two properties carry the weight, and both are here because review caught them
 * missing rather than because a run failed:
 *
 *   1. THE BUCKETS PARTITION. Two successive drafts of the spec left an item shape in no bucket at
 *      all — first 4-7-chunk items, then 1-chunk-but-large items. A hole is silent: the item is just
 *      never selected, the corpus quietly misrepresents prod, and C1 (which is corpus-mix-sensitive)
 *      transfers wrongly. So totality is asserted directly over the whole domain, not sampled.
 *   2. `chunkCount` AGREES WITH `chunkContent`. The battery counts episodes from `length(body)` in
 *      SQL rather than chunking thousands of bodies, which is a re-derivation of the projector's
 *      algorithm — exactly the kind of parallel implementation that drifts. Pinned against the real
 *      function, including the cap and the whitespace case.
 */

describe("the buckets partition every item the graph can see", () => {
  it("assigns a bucket to EVERY chunk count from 1 to the cap — no shape falls through", () => {
    const unbucketed: number[] = [];
    for (let n = 1; n <= MAX_EPISODE_CHUNKS; n++) {
      // Probe both sides of the small-item threshold, since bucketing at n=1 depends on chars too.
      for (const chars of [1, SMALL_ITEM_CHARS - 1, SMALL_ITEM_CHARS, 2500, 100_000]) {
        if (bucketOf(n, chars) === null) unbucketed.push(n);
      }
    }
    expect(unbucketed).toEqual([]);
  });

  it("puts a 1-chunk item of 600-2,500 chars in B2 — the hole the second draft opened", () => {
    expect(bucketOf(1, 1200)).toBe("B2");
  });

  it("puts a 4-7-chunk item in C — the hole the first draft opened", () => {
    expect(bucketOf(4, 9000)).toBe("C");
    expect(bucketOf(7, 17_000)).toBe("C");
  });

  it("separates the small tail (B1) from the rest of the single-chunk population (B2)", () => {
    expect(bucketOf(1, SMALL_ITEM_CHARS - 1)).toBe("B1");
    expect(bucketOf(1, SMALL_ITEM_CHARS)).toBe("B2");
  });

  it("sends 8-or-more chunks to A — the coreference case the lever must not break", () => {
    expect(bucketOf(8, 20_000)).toBe("A");
    expect(bucketOf(40, 100_000)).toBe("A");
  });

  it("returns null for a whitespace-only item — the projector skips it, so it is not a hole", () => {
    expect(bucketOf(chunkCount(500, true), 500)).toBeNull();
    expect(bucketOf(0, 0)).toBeNull();
  });
});

describe("chunkCount is the projector's algorithm, not a paraphrase of it", () => {
  const cases = [1, 100, 2499, 2500, 2501, 5000, 7501, 99_000, 250_000];

  it.each(cases)("agrees with chunkContent for a %i-char body", (chars) => {
    expect(chunkCount(chars)).toBe(chunkContent("x".repeat(chars)).length);
  });

  it("agrees on the cap — a body past CHUNK_CHARS * MAX_EPISODE_CHUNKS is clipped, not extrapolated", () => {
    const huge = 2500 * (MAX_EPISODE_CHUNKS + 12);
    expect(chunkCount(huge)).toBe(MAX_EPISODE_CHUNKS);
    expect(chunkContent("x".repeat(huge))).toHaveLength(MAX_EPISODE_CHUNKS);
  });

  it("agrees that a whitespace-only body yields no episodes at all", () => {
    expect(chunkContent("   \n\t ")).toEqual([]);
    expect(chunkCount(6, true)).toBe(0);
  });
});

describe("selectCorpus — deterministic, newest-first, capped per bucket", () => {
  // Newest first, as the SQL orders them. Deliberately interleaved so "takes the newest N of each
  // bucket" is a real claim rather than an artefact of grouped input.
  const rows = [
    { id: "a1", chars: 30_000 }, // A  (12 chunks)
    { id: "s1", chars: 200 }, // B1
    { id: "c1", chars: 6000 }, // C  (3 chunks)
    { id: "a2", chars: 25_000 }, // A  (10 chunks)
    { id: "m1", chars: 1500 }, // B2
    { id: "s2", chars: 100 }, // B1
    { id: "a3", chars: 21_000 }, // A  (9 chunks)
    { id: "s3", chars: 550 }, // B1
    { id: "c2", chars: 12_000 }, // C  (5 chunks)
    { id: "m2", chars: 900 }, // B2
  ];

  it("caps each bucket at its target and keeps the newest", () => {
    const got = selectCorpus(rows, { A: 2, B1: 2, B2: 1, C: 1 });
    expect(got.byBucket.A.map((i: { id: string }) => i.id)).toEqual(["a1", "a2"]);
    expect(got.byBucket.B1.map((i: { id: string }) => i.id)).toEqual(["s1", "s2"]);
    expect(got.byBucket.B2.map((i: { id: string }) => i.id)).toEqual(["m1"]);
    expect(got.byBucket.C.map((i: { id: string }) => i.id)).toEqual(["c1"]);
  });

  it("is deterministic — the same rows give the same corpus, which is what 'pinned item ids' means", () => {
    const a = selectCorpus(rows);
    const b = selectCorpus(rows);
    expect(a.items.map((i: { id: string }) => i.id)).toEqual(b.items.map((i: { id: string }) => i.id));
  });

  it("counts episodes, not items — the unit every band is expressed in", () => {
    const got = selectCorpus(rows, { A: 1, B1: 1, B2: 0, C: 0 });
    expect(got.episodes).toBe(12 + 1);
  });

  it("reports a shortfall rather than silently returning a thin corpus", () => {
    const got = selectCorpus(rows.slice(0, 3), BUCKET_TARGETS);
    // Reads the target rather than restating it: a test that hardcodes the constant it is checking
    // goes red for a deliberate retarget and green for a typo, which is backwards.
    expect(got.shortfall.join(" ")).toMatch(new RegExp(`A: wanted ${BUCKET_TARGETS.A}, found 1`));
  });

  it("skips whitespace-only items entirely", () => {
    const got = selectCorpus([{ id: "blank", chars: 800, blank: true }], { A: 5, B1: 5, B2: 5, C: 5 });
    expect(got.items).toEqual([]);
    expect(got.episodes).toBe(0);
  });

  it("reports the single-chunk episode share, because C1 is corpus-mix-sensitive", () => {
    // Prod's is ~17% (898 of 5,166). A corpus far from that makes a blended tokens/episode figure
    // untransferable, so the number has to be visible rather than assumed.
    const got = selectCorpus(rows, BUCKET_TARGETS);
    const single = got.items.filter((i: { chunks: number }) => i.chunks === 1).length;
    expect(got.singleChunkEpisodeShare).toBeCloseTo(single / got.episodes, 10);
  });
});

describe("the episode budget guards Q5's band, whose number means nothing without a corpus size", () => {
  /**
   * Q5's 3pp band and 1.5pp ceiling were derived at ~100 episodes, where one validation retry moves
   * the signed gap by ~1pp. At 153 episodes one retry is 0.65pp and the SAME ceiling silently
   * tolerates 2.3 retries — the number unchanged, its meaning changed. This is the guard that makes
   * that visible instead of quiet.
   */
  const big = Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, chars: 100_000 })); // 40 chunks each
  // Read the budget rather than restate it: a test that hardcodes the constant it checks goes red
  // for a deliberate retarget and green for a typo, which is backwards.
  const rangeRe = new RegExp(`outside the ${EPISODE_BUDGET.min}-${EPISODE_BUDGET.max} range`);

  it("breaches when the corpus is far larger than the band was derived at", () => {
    const got = selectCorpus(big, { A: 5, B1: 0, B2: 0, C: 0 });
    expect(got.episodes).toBe(200);
    expect(got.episodeBudgetBreach).toMatch(rangeRe);
  });

  it("breaches when it is far smaller, too — a thin corpus makes one retry huge", () => {
    const got = selectCorpus([{ id: "s", chars: 100 }], { A: 0, B1: 1, B2: 0, C: 0 });
    expect(got.episodeBudgetBreach).toMatch(rangeRe);
  });

  it("passes inside the range", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, chars: 100 }));
    const got = selectCorpus(rows, { A: 0, B1: 100, B2: 0, C: 0 });
    expect(got.episodes).toBe(100);
    expect(got.episodeBudgetBreach).toBeNull();
  });
});
