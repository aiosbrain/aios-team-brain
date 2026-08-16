import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cdcBoundaries, chunkCdc } from "@/lib/graph/cdc";
import {
  CDC_PARAMS,
  CHUNK_CHARS,
  CHUNK_CONFIG,
  CHUNK_MAX_CHARS,
  CHUNK_MIN_CHARS,
  MAX_EPISODE_CHUNKS,
  chunkContent,
  chunkContentLegacy,
} from "@/lib/graph/project";

/**
 * `cdc1` — content-defined chunking (PIPEFF-3 / AIO-826).
 *
 * Spec: docs/design/content-defined-chunking.md. Written from the spec's acceptance table and its
 * stated requirements, not from the implementation.
 *
 * ⚠️ THE SPEC IS EXPLICIT THAT A PURE-FUNCTION TEST IS NOT THE GATE: "it stays green while the
 * projector re-pushes everything". The gate is the projector-level acceptance in
 * `test/datamechanics/graph-chunk-delta.datamechanics.test.ts` ("a 33-char insertion near the top of a
 * CDC-stored item sends ≤ 3 episodes"). What lives here is everything that tier cannot see: the
 * definition of `cdc1` itself, the size envelope, and the churn arithmetic against the legacy algorithm.
 */

// ── FIXTURES ─────────────────────────────────────────────────────────────────────────────────────
// Real-SHAPED, not real content: the spec asks for this install's own document shapes (lengths and
// edit positions), checked in without the sensitive text. Generated from a fixed LCG so every run
// sees the same bytes — a fixture drawn from `Math.random` would make every assertion below a
// different experiment each run.

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

const WORDS = [
  "the", "brain", "projects", "items", "into", "graphiti", "episodes", "chunked", "by", "content",
  "defined", "boundaries", "which", "survive", "an", "insertion", "near", "the", "top", "of", "a",
  "document", "because", "the", "hash", "rolls", "over", "a", "window", "not", "an", "offset", "from",
  "the", "start", "ledger", "delta", "extraction", "cap", "tier", "isolation", "projector", "corpus",
];

/** Prose-shaped body of exactly `n` UTF-16 code units. Deterministic in `seed`. */
function doc(n: number, seed = 3): string {
  const r = lcg(seed);
  let out = "";
  while (out.length < n) {
    const words = Math.floor(r() * 12) + 4;
    const parts: string[] = [];
    for (let i = 0; i < words; i++) parts.push(WORDS[Math.floor(r() * WORDS.length)]);
    out += parts.join(" ") + (r() < 0.15 ? ".\n\n" : ". ");
  }
  return out.slice(0, n);
}

/** The median item in this install is ~240 chars — one chunk, and under the CDC minimum. */
const MEDIAN_ITEM = doc(240, 11);
/** The measured churn document: 50,000 chars ≈ 20 chunks, the shape the spec's table is stated over. */
const DOC_50K = doc(50_000, 3);

/**
 * This repo's own markdown ≥ 15K — real content, not prose-shaped noise.
 *
 * Synthetic prose is uniformly high-entropy, so it hides the failure mode that actually bit here: real
 * documents have hash-quiet runs (tables, code fences, indentation) where no boundary is found for
 * thousands of characters. Read from disk rather than checked in, deliberately — the point is to keep
 * measuring against the corpus as it is now, and a snapshot would stop being real the week after.
 */
function repoDocs(): string[] {
  const dirs = ["docs", "docs/design", "."];
  const out: string[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(join(process.cwd(), dir));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      try {
        const text = readFileSync(join(process.cwd(), dir, name), "utf8");
        if (text.length >= 15_000) out.push(text);
      } catch {
        // a symlink or a race with another worktree — not what this test is measuring
      }
    }
  }
  return out;
}

// ── THE DEFINITION OF `cdc1` ─────────────────────────────────────────────────────────────────────

describe("cdc1 is pinned by a checked-in boundary fixture — a silent drift is a build failure", () => {
  /**
   * The spec: "`cdc1` is the reproducibility contract, not the numbers beside it… `cdc1` pins [the gear
   * table, the window length, the mask derivation, the unit]; changing any one is `cdc2`, and the
   * checked-in boundary fixture is what makes a silent drift a build failure. The fixture is not a
   * nicety, it is the definition of `cdc1`."
   *
   * So: if this list changes, you have written `cdc2`, and every stored `cdc1-*` row in every install
   * silently stops reproducing. Bump the config string (and think about the corpus) rather than
   * updating these numbers.
   */
  const EXPECTED_BOUNDARIES_50K = [
    2540, 5096, 8543, 10279, 12952, 15489, 18901, 22012, 24162, 27380, 30887, 33458, 36025, 38618,
    41127, 44367, 47977, 49368, 50000,
  ];

  it("produces exactly the recorded boundary sequence for the 50,000-char fixture", () => {
    expect(cdcBoundaries(DOC_50K, CDC_PARAMS)).toEqual(EXPECTED_BOUNDARIES_50K);
  });

  it("the fixture is the one the numbers were recorded against (length + a content anchor)", () => {
    // A fixture that silently changed shape would let the list above be 'fixed' by regenerating it,
    // which is the failure this whole guard exists to prevent.
    expect(DOC_50K).toHaveLength(50_000);
    expect(DOC_50K.slice(0, 32)).toBe("the extraction the near extracti");
  });

  it("the config string names the parameters those boundaries were produced under", () => {
    expect(CHUNK_CONFIG).toBe("cdc1-2500-1250-4000-80");
  });
});

describe("determinism — the delta ledger rests on 'same body ⇒ same chunks ⇒ same hashes'", () => {
  it("chunking the same fixture twice is identical", () => {
    expect(chunkContent(DOC_50K)).toEqual(chunkContent(DOC_50K));
    expect(cdcBoundaries(DOC_50K, CDC_PARAMS)).toEqual(cdcBoundaries(DOC_50K, CDC_PARAMS));
  });

  it("contains no source of run-to-run variation (no Math.random, Date, or locale ops)", async () => {
    // Cheap, but it is the term that would make every other test here vacuously green: a randomly
    // seeded gear table is self-consistent WITHIN a process, so the assertion above cannot see it.
    // Comments are stripped first — this file's own prose explains why `Math.random` is absent, and a
    // guard that its own rationale trips is a guard nobody can write honestly.
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(new URL("../lib/graph/cdc.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[^\n"'`]*\/\/.*$/gm, "");
    expect(code, "comment-stripping must not have emptied the file").toContain("export function chunkCdc");
    for (const banned of ["Math.random", "Date.now", "new Date", "toLocale", "localeCompare", ".normalize("]) {
      expect(code, `cdc.ts must not use ${banned}`).not.toContain(banned);
    }
  });
});

// ── THE SIZE ENVELOPE ────────────────────────────────────────────────────────────────────────────

describe("the size envelope — the minimum is content safety, not a tuning knob", () => {
  it("min x cap is at least the 100,000 characters the byte-offset era guaranteed", () => {
    // The spec's requirement: "the cap must be raised in the same change to MAX_EPISODE_CHUNKS such
    // that min_chunk x cap >= 100,000". Shipping CDC without it silently reduces how much of a large
    // document reaches the graph — the CHUNKCAP-1 class.
    expect(CHUNK_MIN_CHARS * MAX_EPISODE_CHUNKS).toBeGreaterThanOrEqual(100_000);
    expect(MAX_EPISODE_CHUNKS).toBe(80);
    expect(CHUNK_MIN_CHARS).toBe(1250);
    expect(CHUNK_MAX_CHARS).toBe(4000);
    expect(CHUNK_CHARS).toBe(2500);
  });

  it("every chunk but the last respects [min, max]; the last may be short", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const text = doc(120_000, seed);
      const chunks = chunkCdc(text, CDC_PARAMS, Number.MAX_SAFE_INTEGER);
      expect(chunks.join("")).toBe(text); // uncapped ⇒ every character preserved, in order
      chunks.slice(0, -1).forEach((c, i) => {
        expect(c.length, `seed ${seed} chunk ${i} below the minimum`).toBeGreaterThanOrEqual(CHUNK_MIN_CHARS);
        // `max + 1` is reachable: a boundary inside a surrogate pair shifts +1 so the pair stays whole.
        expect(c.length, `seed ${seed} chunk ${i} above the maximum`).toBeLessThanOrEqual(CHUNK_MAX_CHARS + 1);
      });
    }
  });

  it("realizes an average near the 2,500 target with hard cuts well under the 11% a plain gear costs", () => {
    // The spec's stated cost of choosing max=4,000: "a plain gear-hash hard-cuts whenever no boundary
    // appears in 2,750 chars — roughly 11% of chunks… Mitigation, already implied by 'FastCDC-shaped':
    // use FastCDC normalized chunking, which varies the mask to make max-cuts rare." A hard cut is a
    // POSITION-defined boundary, so this is not cosmetic — it is the fraction of boundaries that behave
    // like the byte-offset algorithm this lever replaces, and it is what drove the delete row of the
    // churn table to 12 before the backup boundary was added.
    const lengths: number[] = [];
    for (const seed of [7, 8, 9, 10, 11, 12]) {
      const chunks = chunkCdc(doc(200_000, seed), CDC_PARAMS, Number.MAX_SAFE_INTEGER);
      lengths.push(...chunks.slice(0, -1).map((c) => c.length));
    }
    const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const hardCuts = lengths.filter((l) => l >= CHUNK_MAX_CHARS).length / lengths.length;
    expect(avg).toBeGreaterThan(2_200);
    expect(avg).toBeLessThan(2_900);
    expect(hardCuts).toBeLessThan(0.02);
  });

  it("holds on THIS repo's own markdown, which is where the 11% estimate turned out to be 14%", () => {
    // The spec asks for a test "over this install's own documents". These are the closest thing in the
    // tree: prose + tables + code fences, including a 349K file whose giant tables are hash-quiet for
    // thousands of characters at a time. Synthetic prose is uniformly noisy and would have hidden the
    // hard-cut problem entirely.
    const lengths: number[] = [];
    for (const text of repoDocs()) {
      const chunks = chunkCdc(text, CDC_PARAMS, Number.MAX_SAFE_INTEGER);
      lengths.push(...chunks.slice(0, -1).map((c) => c.length));
    }
    expect(lengths.length, "the repo must actually contain large markdown to measure").toBeGreaterThan(100);
    const hardCuts = lengths.filter((l) => l >= CHUNK_MAX_CHARS).length / lengths.length;
    expect(hardCuts).toBeLessThan(0.05);
  });
});

describe("edge fixtures", () => {
  it("a sub-minimum body (the ~240-char median item) is one chunk, not zero and not a floor violation", () => {
    const chunks = chunkContent(MEDIAN_ITEM);
    expect(chunks).toEqual([MEDIAN_ITEM]);
  });

  it("whitespace-only stays [] — the projector's 'nothing to extract' branch depends on it", () => {
    for (const blank of ["", "   \n\t ", "\n\n\n", " "]) expect(chunkContent(blank)).toEqual([]);
    // …and so does the battery's SQL blank predicate, which is checked against this exact behaviour.
    expect(chunkContent(" ".repeat(10_000))).toEqual([]);
  });

  it("never splits a surrogate pair, even when a boundary lands inside one", () => {
    // Astral characters packed densely around every plausible boundary, so the +1 shift is exercised
    // rather than hoped for. A split pair would put a lone surrogate at the end of one chunk and its
    // partner at the start of the next — two chunks of mojibake handed to the extractor.
    const emoji = "\u{1F600}"; // 2 code units
    const text = (doc(60_000, 21) + emoji).replace(/ /g, emoji);
    const chunks = chunkCdc(text, CDC_PARAMS, Number.MAX_SAFE_INTEGER);
    expect(chunks.join("")).toBe(text);
    for (const [i, c] of chunks.entries()) {
      const first = c.charCodeAt(0);
      const last = c.charCodeAt(c.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff, `chunk ${i} starts with a lone low surrogate`).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff, `chunk ${i} ends with a lone high surrogate`).toBe(false);
    }
  });

  it("boundary indices are UTF-16 code-unit indices — the space `slice` uses", () => {
    // Stated in the spec because the alternative is the class this repo has been bitten by (Postgres
    // length() counts characters, JS .length counts code units). If the hash rolled over BYTES while
    // min/max lived in code units, `slice` would cut somewhere else entirely and this would fail.
    const text = doc(30_000, 22).replace(/ /g, "\u{1F600}");
    const ends = cdcBoundaries(text, CDC_PARAMS);
    let start = 0;
    const reassembled = ends.map((e) => {
      const piece = text.slice(start, e);
      start = e;
      return piece;
    });
    expect(reassembled.join("")).toBe(text);
    expect(ends[ends.length - 1]).toBe(text.length);
  });
});

// ── PREFIX STABILITY / TRUNCATION-ONLY CAP SEMANTICS ─────────────────────────────────────────────

describe("the cap only TRUNCATES — the basis on which a CDC cap-grow keeps the stored hashes", () => {
  // A fixture that actually REACHES the cap. The spec is explicit: "A fixture shorter than min x cap
  // never exercises the boundary chunk and proves nothing." At ~2,500 realized average, 80 chunks needs
  // ~200,000 chars; 400,000 clears it with room and is a real shape (ARCHITECTURE.md is ~338K).
  const HUGE = doc(400_000, 31);

  it("the fixture reaches the cap — otherwise the assertions below are vacuous", () => {
    expect(chunkCdc(HUGE, CDC_PARAMS, MAX_EPISODE_CHUNKS)).toHaveLength(MAX_EPISODE_CHUNKS);
    expect(cdcBoundaries(HUGE, CDC_PARAMS).length).toBeGreaterThan(MAX_EPISODE_CHUNKS + 40);
  });

  it("chunks 0..N-1 are byte-identical under cap N and cap N+40", () => {
    const atN = chunkCdc(HUGE, CDC_PARAMS, MAX_EPISODE_CHUNKS);
    const atNPlus = chunkCdc(HUGE, CDC_PARAMS, MAX_EPISODE_CHUNKS + 40);
    expect(atNPlus.length).toBe(MAX_EPISODE_CHUNKS + 40);
    expect(atNPlus.slice(0, MAX_EPISODE_CHUNKS)).toEqual(atN);
  });

  it("THE FINAL PERMITTED CHUNK IS NOT SPECIAL-CASED — no remainder absorbed, no different cut", () => {
    // The tempting implementation absorbs the tail into chunk `cap-1` (or cuts it differently because
    // it knows it is last). Either breaks prefix stability at exactly `cap-1` — which is the ONE index
    // a cap-grow test that only checks 0..cap-2 would miss. Consequence is bounded (a re-pushed chunk
    // and a same-name orphan, not lost content) but it must be pinned, because it is the assumption
    // `chunkConfigDeltaCompatible`'s CDC cap-grow branch rests on.
    for (const cap of [1, 2, 3, 17, MAX_EPISODE_CHUNKS]) {
      const capped = chunkCdc(HUGE, CDC_PARAMS, cap);
      const uncapped = chunkCdc(HUGE, CDC_PARAMS, Number.MAX_SAFE_INTEGER);
      expect(capped, `cap ${cap} must be a pure prefix of the uncapped sequence`).toEqual(
        uncapped.slice(0, cap)
      );
      // …and the last permitted chunk carries no remainder: the dropped text is really dropped.
      expect(capped[capped.length - 1].length).toBeLessThanOrEqual(CHUNK_MAX_CHARS + 1);
    }
  });

  it("the boundary sequence does not take the cap as an input at all", () => {
    // Stated directly rather than inferred from the prefix tests: `cdcBoundaries` has no cap parameter,
    // so there is nowhere for a final-chunk special case to hide.
    expect(cdcBoundaries.length).toBe(2); // (text, params) — a third `cap` arg would be the smell
  });
});

// ── THE CHURN TABLE (the spec's acceptance arithmetic) ───────────────────────────────────────────

describe("churn: how many chunk hashes change under a real edit — CDC vs the byte-offset algorithm", () => {
  /**
   * The spec's central claim, and it is testable for free: "Take a real document, apply a real edit,
   * chunk both versions under each algorithm, count how many chunk hashes changed. No LLM, no cost,
   * exactly reproducible."
   *
   *   | scenario                        | byte-offset (today) | CDC (required) |
   *   | edit in place, same length      | 1 of 20             | 1              |
   *   | append at end                   | 1 of 20             | 1              |
   *   | insert 33 chars near the top    | 21 of 20            | <= 3           |
   *   | insert a paragraph mid-document | ~half               | <= 3           |
   *   | delete a paragraph near the top | ~all                | <= 3           |
   *
   * Both algorithms are measured in the SAME test so the improvement is visible rather than asserted.
   */
  const changedCount = (before: string[], after: string[]): number => {
    const seen = new Set(before);
    return after.filter((c) => !seen.has(c)).length;
  };
  const legacy = (t: string) => chunkContentLegacy(t, CHUNK_CHARS, MAX_EPISODE_CHUNKS);

  const scenarios: { name: string; edit: (t: string) => string; max: number }[] = [
    {
      name: "edit in place, same length",
      edit: (t) => t.slice(0, 20_000) + "XXXXXXXXXXXXXXXXXXXX" + t.slice(20_020),
      max: 1,
    },
    {
      name: "append at end",
      edit: (t) => t + " a new closing paragraph appended at the very end of the document.",
      max: 1,
    },
    {
      name: "insert 33 chars near the top",
      edit: (t) => t.slice(0, 1_200) + "insertion of exactly thirty three" + t.slice(1_200),
      max: 3,
    },
    {
      name: "insert a paragraph mid-document",
      edit: (t) =>
        t.slice(0, 25_000) +
        "\n\nA new middle paragraph that did not exist before, with several words in it.\n\n" +
        t.slice(25_000),
      max: 3,
    },
    {
      name: "delete a paragraph near the top",
      edit: (t) => t.slice(0, 1_500) + t.slice(2_100),
      max: 3,
    },
  ];

  it("the fixture is the ~20-chunk shape the table is stated over", () => {
    expect(legacy(DOC_50K)).toHaveLength(20);
    expect(chunkContent(DOC_50K).length).toBeGreaterThanOrEqual(18);
    expect(chunkContent(DOC_50K).length).toBeLessThanOrEqual(24);
  });

  for (const { name, edit, max } of scenarios) {
    // `edit in place, same length` is covered by its own describe below (CDCCHURN-1): its churn is not
    // a single number but a function of what the edit touches, and asserting a constant here is what
    // made the acceptance table wrong in the first place.
    //
    // `append at end` is the same defect one row down (CDCAPPEND-1), and its `<= 1` was asserted against
    // ONE fixture and ONE 66-character append. Over the live corpus that append churns 2 on 4 of 28
    // documents, and the same fixture with a 2,500-character prose append churns 3 — so the constant is
    // a property of this fixture, not of appends. The bound, the absolute ceiling and the per-document
    // legacy envelope live in the CDCAPPEND-1 describe below.
    if (name === "edit in place, same length" || name === "append at end") continue;
    it(`${name} — CDC re-extracts <= ${max} chunk(s)`, () => {
      const v2 = edit(DOC_50K);
      const cdcChurn = changedCount(chunkContent(DOC_50K), chunkContent(v2));
      const legacyChurn = changedCount(legacy(DOC_50K), legacy(v2));
      expect(cdcChurn, `CDC churn for "${name}" (legacy was ${legacyChurn})`).toBeLessThanOrEqual(max);
      // The improvement is visible, not merely asserted: CDC must never be WORSE than byte offsets.
      expect(cdcChurn).toBeLessThanOrEqual(legacyChurn);
    });
  }

  it("the insertion cascade is real under byte offsets — the baseline this lever exists against", () => {
    // Without this the table above could pass with both algorithms at 1 and prove nothing. Measured in
    // the spec at "21 — all of them, plus the new tail".
    const v2 = DOC_50K.slice(0, 1_200) + "insertion of exactly thirty three" + DOC_50K.slice(1_200);
    expect(changedCount(legacy(DOC_50K), legacy(v2))).toBeGreaterThanOrEqual(20);
  });

  it("holds across several document shapes, not just the one the table was written for", () => {
    for (const seed of [41, 42, 43, 44, 45]) {
      const v1 = doc(50_000, seed);
      const v2 = v1.slice(0, 1_200) + "insertion of exactly thirty three" + v1.slice(1_200);
      expect(
        changedCount(chunkContent(v1), chunkContent(v2)),
        `insertion churn for seed ${seed}`
      ).toBeLessThanOrEqual(3);
    }
  });

  /**
   * …and on REAL documents, where the tail is honest rather than flattering.
   *
   * Stated as a median plus a named ceiling, not as a single worst case, because the spec is explicit
   * that "'at worst its immediate neighbour' would overclaim: because each boundary is anchored at the
   * previous one, realignment after an insertion is empirical rather than guaranteed, and pathological
   * low-entropy content can propagate a shift across several chunks."
   *
   * Measured over this repo's markdown at the time of writing: insertion and in-place edits sit at a
   * median of 1 and a worst case of 3; a DELETION near the top is the hard direction (median 2, worst 5
   * — see the asymmetry note in lib/graph/cdc.ts). Every one of those is against a legacy worst case of
   * 80 — i.e. the entire capped document.
   */
  it("real repo documents: median churn 1-2, ceiling 6, against a legacy ceiling of the whole document", () => {
    const docs = repoDocs();
    expect(docs.length).toBeGreaterThan(5);
    for (const { name, edit } of scenarios) {
      const cdc: number[] = [];
      const leg: number[] = [];
      for (const t of docs) {
        const v2 = edit(t);
        cdc.push(changedCount(chunkContent(t), chunkContent(v2)));
        leg.push(changedCount(legacy(t), legacy(v2)));
      }
      // `edit in place, same length` is excluded from BOTH assertions here, not just the second one
      // (CDCCHURN-1). The ceiling of 6 is fitted to this one fixed offset: swept across the same corpus,
      // a boundary-disturbing 20-character in-place edit reaches **at least 9 of 80 admitted chunks**
      // (`docs/ARCHITECTURE.md`@178,189), against a legacy churn of 1. And "never worse than byte offsets"
      // is simply false for that scenario — byte offsets churn 1 by construction, since offsets do not
      // move. Both claims now live in the describe below, conditioned on what the edit actually touches.
      // The other scenarios still bind, and they are where CDC's win is real: the same corpus gives
      // CDC 1 against legacy 80 for an insertion near the top.
      //
      // `append at end` is excluded from BOTH assertions here too (CDCAPPEND-1), and the reason is the
      // one this comment already names for the row above, firing. The never-worse comparison PASSES for
      // append today only by coincidence ACROSS DIFFERENT DOCUMENTS: at this scenario's own 66-character
      // append CDC is strictly worse than byte offsets on 4 of 28 corpus documents, and `max <= max`
      // survives because a FIFTH, unrelated document churns 2 under legacy. Its outcome also flips with
      // the appended CONTENT at a fixed length — at 2,500 characters it fails under one prose filler,
      // passes under another, and passes with CDC strictly better under a hash-quiet one. It is REPLACED,
      // not deleted: the CDCAPPEND-1 describe asserts `cdc <= legacy + 1` PER DOCUMENT for appends
      // shorter than `min`, which is where that envelope is measured on both real and synthetic corpora.
      if (name === "edit in place, same length" || name === "append at end") continue;
      cdc.sort((a, b) => a - b);
      const median = cdc[Math.floor(cdc.length / 2)];
      expect(median, `${name}: median CDC churn over real docs`).toBeLessThanOrEqual(2);
      expect(Math.max(...cdc), `${name}: worst-case CDC churn over real docs`).toBeLessThanOrEqual(6);
      expect(Math.max(...cdc), `${name}: CDC must never be worse than byte offsets`).toBeLessThanOrEqual(
        Math.max(...leg)
      );
    }
  });
});

// ── CDCCHURN-1: what an in-place same-length edit actually costs ─────────────────────────────────

/**
 * The acceptance table promised an unconditional **1** for `edit in place, same length`, and one real
 * document churns 4. This is the fourth characterisation of that gap; the first three were wrong, and
 * each was cheap prose that would have shipped as documentation:
 *
 *   1. "the test over-asserts, the spec disclaims it" — the table REQUIRES 1;
 *   2. "low-entropy repeated bullets propagate the realignment" — churn is indifferent to entropy;
 *   3. "the edit OVERLAPS a boundary" — true of that document, not the rule: a cut is decided by the
 *      ~32 code units ENDING at it, so an edit near a boundary destroys one it never touches, and
 *      spliced text can create one (9,480 of 15,719 non-overlapping offsets churn > 1);
 *   4. "churn is 1 whenever the boundary SEQUENCE is unchanged" — false in both directions: an edit
 *      spanning a SURVIVING boundary changes both adjacent chunks (churn 2), and an edit past the
 *      80-chunk admitted prefix changes nothing at all (churn 0).
 *
 * THE RULE, verified before it was written down — 5,743 unchanged-sequence samples swept across the
 * corpus at 97-character steps, 5,743 agreements, zero mismatches, under both this file's set-based
 * `changedCount` and a positional diff (they are provably equal in that bucket). Reproduce with
 * `node scripts/cdc-churn-sweep.mjs`, which is committed because a prose recipe did NOT reproduce:
 *
 *   **churn = the number of ADMITTED chunk intervals the changed span intersects.**
 *
 * So exactly 1 needs two things together: the edit changes text, and it lies wholly inside one admitted
 * chunk. (A third condition — "no boundary strictly inside the edit span" — was specified and then
 * deleted as provably dead; see `classify`.) Anything else is reported, not gated — because when
 * the boundary sequence does change there is NO usable ceiling: the same sweep observes **≥ 9 of 80**
 * admitted chunks for a 20-character edit (`docs/ARCHITECTURE.md`@178,189) against a legacy churn of 1
 * — already past the ceiling of 6 this file used to assert. "≥" is deliberate: the sweep steps 97
 * characters, so a maximum from it is a lower bound, and two runs differing only in start offset gave
 * 8 and 9.
 *
 * AND MIND THE METRIC. An earlier draft published 78 here. That is a POSITIONAL count — chunks that
 * differ at the same index — and it is not a cost: `lib/graph/project.ts:1222-1223` filters by
 * `new Set(chunk_shas)` MEMBERSHIP, so a chunk that merely shifts index is never re-pushed. The same
 * state costs 2 under `changedCount`, the metric used throughout this file. The draft then explained
 * the retraction as corpus drift, which review also falsified — the number reproduces on both
 * revisions of that file. Two wrong stories about one number; the sweep script now reports both
 * metrics so they cannot be confused again.
 */
describe("CDCCHURN-1: in-place same-length churn is the number of chunks the edit touches", () => {
  const EDIT_AT = 20_000;
  const EDIT_LEN = 20;
  const inPlace = (t: string) => t.slice(0, EDIT_AT) + "X".repeat(EDIT_LEN) + t.slice(EDIT_AT + EDIT_LEN);
  const changedCount = (before: string[], after: string[]): number => {
    const seen = new Set(before);
    return after.filter((c) => !seen.has(c)).length;
  };

  /** Admitted chunk intervals — CAPPED, because churn is measured on the capped chunking while
   *  `cdcBoundaries` is not. That coordinate mismatch is exactly why a past-cap edit can change the
   *  boundary sequence and still churn 0, so it is named here rather than left to be re-derived. */
  const admittedIntervals = (t: string): [number, number][] => {
    const out: [number, number][] = [];
    let start = 0;
    for (const c of chunkContent(t)) {
      out.push([start, start + c.length]);
      start += c.length;
    }
    return out;
  };

  /**
   * What the rule predicts for a STRICT document, under the metric the product actually pays.
   *
   * The interval count is 1 by construction (that is what `strict` means). The subtraction is the
   * corner a third reviewer constructed and this test now pins: `lib/graph/project.ts` filters by
   * `new Set(chunk_shas)` MEMBERSHIP, so if the edited chunk's new content already exists elsewhere in
   * the document, nothing is re-pushed and the cost is 0. Derived from the rule — never from the churn
   * it is checking — so it cannot pass by restating the answer.
   */
  const expectedStrictChurn = (t: string, at = EDIT_AT, len = EDIT_LEN): number => {
    const holding = admittedIntervals(t).find(([s, e]) => at >= s && at + len <= e);
    if (holding === undefined) return 0; // not strict; the caller does not reach this
    const editedChunk = (t.slice(0, at) + "X".repeat(len) + t.slice(at + len)).slice(holding[0], holding[1]);
    return new Set(chunkContent(t)).has(editedChunk) ? 0 : 1;
  };

  type Bucket = "excluded" | "strict" | "reported";

  /**
   * Three independent facts, in the order that makes each one meaningful. `strict` is the only gated
   * bucket; `reported` covers every way the rule's preconditions fail (boundary disturbed, edit spans a
   * surviving boundary, edit past the admitted prefix), and `excluded` is the documents for which this
   * "in-place edit" is really an append.
   */
  const classify = (t: string, at = EDIT_AT, len = EDIT_LEN): Bucket => {
    if (t.length < at + len) return "excluded";
    const edited = t.slice(0, at) + "X".repeat(len) + t.slice(at + len);
    // The rule's first precondition, which all three documents stated and the classifier omitted
    // (review): an edit that changes nothing churns 0, not 1. Latent today — no corpus document holds
    // a 20-character X-run at the edit site — but the classifier should match the rule it implements.
    if (edited === t) return "excluded";
    const before = cdcBoundaries(t, CDC_PARAMS);
    if (JSON.stringify(before) !== JSON.stringify(cdcBoundaries(edited, CDC_PARAMS))) return "reported";
    // ONE term, not two — and the second time this deletion has been attempted: the first went into a
    // commit message while a mutation revert quietly took the edit itself (found by review; the same
    // "commit claims vs file state" scar this repo already carries). The deleted term was
    // `before.some((b) => b > at && b < at + len)`, and it is provably dead: admitted intervals are
    // delimited by consecutive `before` boundaries, so a boundary strictly inside the edit span cannot
    // sit inside one interval — `holding` is already undefined there. A predicate term no test can
    // redden is one the code asserts on trust, and with it present, deleting the `holding` check left
    // every test green: the two conditions masked each other.
    const holding = admittedIntervals(t).find(([s, e]) => at >= s && at + len <= e);
    return holding === undefined ? "reported" : "strict"; // spans two chunks, or lies past the cap
  };

  it("STRICT FIXTURE: an edit far from every boundary churns exactly 1", () => {
    // Checked in rather than relying on the live corpus, because the live strict assertion below
    // quantifies over a bucket a broken classifier could empty — and an assertion over an empty set is
    // green. This fixture makes the strict branch impossible to lose.
    const t = doc(50_000, 7);
    const intervals = admittedIntervals(t);
    const widest = intervals.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));
    const at = Math.floor((widest[0] + widest[1]) / 2) - EDIT_LEN / 2;
    expect(classify(t, at), "the fixture must land in the strict bucket").toBe("strict");
    const edited = t.slice(0, at) + "X".repeat(EDIT_LEN) + t.slice(at + EDIT_LEN);
    expect(changedCount(chunkContent(t), chunkContent(edited))).toBe(1);
  });

  it("CHANGED FIXTURE: an edit centred on a boundary destroys it — asserted, not assumed", () => {
    // Centring is NOT a guarantee of destruction: the mask can re-fire on the spliced content, and a
    // reviewer constructed exactly that. Without these assertions the branch could go silently dead
    // while the test stayed green, which is the failure this whole ticket is about.
    const t = doc(50_000, 11);
    const before = cdcBoundaries(t, CDC_PARAMS);
    const target = before.find((b) => b > 5_000 && b < t.length - 5_000);
    expect(target, "the fixture has no interior boundary to target").toBeDefined();
    const at = target! - EDIT_LEN / 2;
    const edited = t.slice(0, at) + "X".repeat(EDIT_LEN) + t.slice(at + EDIT_LEN);
    const after = cdcBoundaries(edited, CDC_PARAMS);
    expect(before).toContain(target!); // it was there…
    expect(after).not.toContain(target!); // …and the edit really destroyed it
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
    expect(classify(t, at)).toBe("reported");
    // A DIRECTION, never a magnitude: the corpus already reaches ≥9 of 80, so any ceiling here would be
    // a property of this fixture rather than of the chunker.
    expect(changedCount(chunkContent(t), chunkContent(edited))).toBeGreaterThanOrEqual(2);
  });

  it("SHORT FIXTURE: a document under the edit span is excluded, not silently measured as an append", () => {
    // The scenario has been applying `slice(0,20000) + X*20 + slice(20020)` to documents shorter than
    // 20,020 characters, where it is a 20-char APPEND — 10 of the 25 live documents today. Two
    // operations under one name is how the ceiling absorbed a number nobody attributed. The fixture is
    // checked in so the excluded bucket is non-empty regardless of what the corpus holds; pinning the
    // LIVE excluded count would re-create the corpus dependence this ticket exists to remove
    // (`docs/design/graph-extraction-cap.md` is ~56 characters from leaving that set).
    expect(classify(doc(16_000, 5))).toBe("excluded");
    expect(classify(doc(EDIT_AT + EDIT_LEN - 1, 5))).toBe("excluded"); // one short of eligible
    expect(classify(doc(EDIT_AT + EDIT_LEN, 5))).not.toBe("excluded"); // exactly eligible
  });

  it("SPANNING FIXTURE: an unchanged sequence is NOT enough — the edit must sit inside one chunk", () => {
    // MUTATION-FOUND GAP. Deleting the interior-boundary condition — i.e. restoring draft 2's false
    // rule, "unchanged sequence ⇒ churn 1" — left every test green, because on today's corpus the
    // sequence check catches the one document that would expose it first. Two conditions masking each
    // other is defense-in-depth hiding a mutation, so each now has a fixture that isolates it.
    //
    // Here the boundary at 8,543 SURVIVES the edit (the sequence is identical) but the edit spans it,
    // so both adjacent chunks change: churn 2, not 1.
    const t = doc(50_000, 3);
    const at = 8_528;
    const boundary = 8_543;
    const before = cdcBoundaries(t, CDC_PARAMS);
    const edited = t.slice(0, at) + "X".repeat(EDIT_LEN) + t.slice(at + EDIT_LEN);
    expect(before).toContain(boundary);
    expect(cdcBoundaries(edited, CDC_PARAMS)).toEqual(before); // sequence UNCHANGED…
    expect(at).toBeLessThan(boundary);
    expect(at + EDIT_LEN).toBeGreaterThan(boundary); // …but the edit spans the surviving boundary
    expect(classify(t, at)).toBe("reported");
    expect(changedCount(chunkContent(t), chunkContent(edited))).toBe(2);
  });

  it("WINDOW FIXTURE: fitting inside one chunk is NOT enough — the sequence must also survive", () => {
    // The mirror mutation: deleting the boundary-sequence comparison also left everything green, for the
    // same masking reason. Here the edit sits wholly inside one original chunk and still changes the
    // sequence, because a cut is decided by the ~32 code units ENDING at it — so an edit 25 characters
    // short of the boundary at 4,374 destroys it without touching it. This is mechanism (3) from the
    // header, the one that killed draft 1's overlap rule.
    const t = doc(50_000, 1);
    const at = 4_349;
    const boundary = 4_374;
    const before = cdcBoundaries(t, CDC_PARAMS);
    const edited = t.slice(0, at) + "X".repeat(EDIT_LEN) + t.slice(at + EDIT_LEN);
    expect(before).toContain(boundary);
    expect(at + EDIT_LEN).toBeLessThan(boundary); // the edit does NOT overlap the boundary…
    expect(cdcBoundaries(edited, CDC_PARAMS)).not.toEqual(before); // …and destroys it anyway
    expect(cdcBoundaries(edited, CDC_PARAMS)).not.toContain(boundary); // that boundary specifically
    expect(admittedIntervals(t).some(([lo, hi]) => at >= lo && at + EDIT_LEN <= hi)).toBe(true);
    expect(classify(t, at)).toBe("reported");
  });

  it("NO-OP FIXTURE: an edit that changes nothing is excluded, not counted as a churn-1 edit", () => {
    // MUTATION-FOUND (review): the `edited === t` term had no fixture, so deleting it left every test
    // green — the same "a predicate term no test can redden is asserted on trust" rule this file
    // invokes twice elsewhere. Without the term this document classifies STRICT and churns 0, so the
    // live assertion's `toBe(1)` would fail on it.
    const base = doc(50_000, 9);
    const t = base.slice(0, EDIT_AT) + "X".repeat(EDIT_LEN) + base.slice(EDIT_AT + EDIT_LEN);
    expect(inPlace(t)).toBe(t); // the edit is a no-op on this document
    expect(classify(t)).toBe("excluded");
    expect(changedCount(chunkContent(t), chunkContent(inPlace(t)))).toBe(0);
  });

  it("DUPLICATE FIXTURE: a touched chunk that coincides with an existing one costs NOTHING", () => {
    // Constructed by the third reviewer (Codex) and reproduced here: a document built from a repeated
    // block, with the post-edit content of the edited chunk planted in an earlier copy. The edit
    // changes text, the boundary sequence is unchanged and the span sits inside one admitted chunk —
    // every precondition of "strict" — yet SET churn is 0, because the edited chunk is byte-identical
    // to one already in the ledger and `lib/graph/project.ts:1222` filters by set membership.
    //
    // The other two reviewers judged this unconstructible from real markdown, and they were right that
    // it needs contrived content — but the RULE is a general claim, and a general claim with a
    // counterexample is what this whole ticket is about.
    const block = doc(10_000, 21);
    const t0 = block.repeat(5);
    const holding = admittedIntervals(t0).find(([s, e]) => EDIT_AT >= s && EDIT_AT + EDIT_LEN <= e)!;
    const editedChunk =
      t0.slice(holding[0], EDIT_AT) + "X".repeat(EDIT_LEN) + t0.slice(EDIT_AT + EDIT_LEN, holding[1]);
    const twinAt = holding[0] - block.length;
    const t = t0.slice(0, twinAt) + editedChunk + t0.slice(twinAt + (holding[1] - holding[0]));

    expect(classify(t)).toBe("strict"); // every precondition of the strict bucket holds…
    expect(changedCount(chunkContent(t), chunkContent(inPlace(t)))).toBe(0); // …and the cost is 0
    // Positional churn is still 1 — which is exactly why the two metrics must not be conflated.
    const before = chunkContent(t);
    const after = chunkContent(inPlace(t));
    expect(after.filter((c, i) => before[i] !== c).length).toBe(1);
    expect(expectedStrictChurn(t)).toBe(0); // and the rule predicts it
  });

  it("LIVE CORPUS: the in-place median stays at 1 — the assertion that would have caught this", () => {
    // Dropping the ceiling took the MEDIAN with it, and review was right that this went too far: the
    // median is metric-robust (set and positional agree in the strict bucket, which is most of the
    // corpus) and it is the assertion that would have caught the original defect, where one document
    // churned 4 while every other churned 1. A ceiling is unassertable; a median is not.
    const docs = repoDocs();
    const churns = docs
      .filter((t) => classify(t) !== "excluded")
      .map((t) => changedCount(chunkContent(t), chunkContent(inPlace(t))))
      .sort((a, b) => a - b);
    expect(churns.length).toBeGreaterThan(5);
    expect(churns[Math.floor(churns.length / 2)], "median in-place churn over real documents").toBe(1);
  });

  it("LIVE CORPUS: every strictly-classified document churns exactly 1", () => {
    const docs = repoDocs();
    expect(docs.length).toBeGreaterThan(5);
    const counts: Record<Bucket, number> = { excluded: 0, strict: 0, reported: 0 };
    for (const t of docs) {
      const bucket = classify(t);
      counts[bucket]++;
      if (bucket !== "strict") continue;
      // Per document, not as a corpus maximum: a maximum lets one outlier dominate, which is how the
      // original defect hid — and how it was then mis-diagnosed three times.
      //
      // And the expectation is DERIVED from the rule, not the constant 1, because of the corner the
      // third reviewer constructed: under the SET metric the ledger pays, a touched chunk whose
      // post-edit content already exists elsewhere in the document costs NOTHING, so a strict document
      // can legitimately churn 0. Asserting a flat 1 would redden on a true negative. This computes
      // what the rule predicts and asserts that.
      expect(
        changedCount(chunkContent(t), chunkContent(inPlace(t))),
        "strict document churn must equal what the rule predicts"
      ).toBe(expectedStrictChurn(t));
    }
    // HONEST ABOUT WHAT THIS IS (review): the sum is a TAUTOLOGY for any total classifier — one that
    // returned "reported" for everything would satisfy it. It is kept because it pins TOTALITY (every
    // document lands in exactly one bucket); what it does NOT do is catch a reports-everything
    // classifier. The STRICT fixture above catches that, and the floor below keeps the live assertion
    // from silently measuring nothing.
    expect(counts.excluded + counts.strict + counts.reported).toBe(docs.length);
    // A floor, not a pinned count: today 14 of 25 documents classify strict, and pinning that number
    // would re-create the corpus dependence this ticket exists to remove.
    expect(counts.strict, "no live document classified strict — the assertion above ran on nothing").toBeGreaterThan(0);
  });
});

// ── CDCAPPEND-1: what an append at the end actually costs ────────────────────────────────────────

/**
 * The acceptance table promised an unconditional **1** for `append at end`. SIX characterisations of that
 * row have now been falsified, and the last three were falsified during this ticket:
 *
 *   1. "churn is 1" — `docs/ARCHITECTURE.md` churns 0 (past the cap) and 4 of 28 corpus documents churn
 *      2 at this file's own 66-character append;
 *   2. "1 unless the appended text splits the final chunk, then 2" — the 2s are not splits of the final
 *      chunk; the new cut lands INSIDE the appended region and moves the chunk before it too;
 *   3. "2 is the ceiling" — holds only below `min`; 9,000 characters churn 4–5 and 60,000 churn 23–24;
 *   4. "1 + the number of new chunks, or 0 when capped" — 449 of 560 swept samples (80.2%). A final
 *      chunk taken by the `n - start <= min` short-tail exit gets a real cut once the document grows, so
 *      a boundary moves without a chunk being added;
 *   5. the bound stated over the BOUNDARY sequences — false for a whitespace-only body, because
 *      `chunkCdc` trims to `[]` while `cdcBoundaries` does not: 20,000 spaces plus one `x` churns 6
 *      against a boundary-form bound of 1 (WHITESPACE fixture);
 *   6. "0 once the document fills the cap" — false: a document at exactly 80 boundaries churns 1. What
 *      must reach the cap is the SHARED PREFIX, not the boundary count (CAPPED fixture).
 *
 * THE RULE, stated in the coordinates the cost is paid in — `C0`/`C1` are the ADMITTED chunk arrays and
 * `L` is the length of their longest common prefix:
 *
 *   **churn <= |C1| - L.**
 *
 * That is a theorem, and a weak one: it holds for ANY two string arrays, since elements below `L` are
 * members of the before-set by definition. So it is asserted because it is what the design document
 * claims, NOT as evidence — the live guards are the ABSOLUTE ceiling and the legacy envelope below, and
 * the informative measurement is that the bound is TIGHT under the set metric (560/560 swept samples)
 * everywhere except duplicate content.
 *
 * Reproduce every number with
 * `node scripts/cdc-churn-sweep.mjs --op append --exclude docs/design/cdc-append-churn.md`.
 * `--exclude` is load-bearing: the design documents are the corpus, so a document publishing a
 * distribution is inside it — an earlier draft's table had already gone stale by the time it was read.
 */
describe("CDCAPPEND-1: append churn is a bound, not a number", () => {
  const changedCount = (before: string[], after: string[]): number => {
    const seen = new Set(before);
    return after.filter((c) => !seen.has(c)).length;
  };
  const positionalCount = (before: string[], after: string[]): number =>
    after.filter((c, i) => before[i] !== c).length;
  const legacy = (t: string) => chunkContentLegacy(t, CHUNK_CHARS, MAX_EPISODE_CHUNKS);

  /** The last chunk the two chunkings share. In CHUNK coordinates, which is where the cost is paid. */
  const sharedPrefix = (before: string[], after: string[]): number => {
    let l = 0;
    while (l < before.length && l < after.length && before[l] === after[l]) l++;
    return l;
  };
  const bound = (before: string[], after: string[]): number =>
    Math.max(0, after.length - sharedPrefix(before, after));

  /**
   * THE ABSOLUTE CEILING — the one thing here a regressed chunker cannot satisfy by construction.
   *
   * `bound` is computed from the chunker's own output, so a chunker that re-cuts deeply just shrinks `L`
   * and inflates the bound to match. This ceiling comes from the SIZE ENVELOPE instead: only boundaries
   * whose chunk start lies within `max` of the old end can move (`cdcBoundaries` reads
   * `text[start … min(start + max, n))`), non-final chunks are at least `min`, so at most
   * `1 + floor((max-1)/min)` of them are in play — and the appended text adds at most `ceil(A/min)`.
   *
   * DERIVED from `CDC_PARAMS`, never hardcoded, so a parameter change moves the ceiling with it.
   */
  const DEPTH_CEILING = 1 + Math.floor((CDC_PARAMS.max - 1) / CDC_PARAMS.min);
  const absoluteCeiling = (appendLength: number): number =>
    DEPTH_CEILING + Math.ceil(appendLength / CDC_PARAMS.min);

  /** Two append CONTENTS at every length: churn depends on the appended text, not only its size. */
  const prose = (n: number) => doc(n, 77);
  const quiet = (n: number) => "a".repeat(n);
  const APPEND_LENGTHS = [1, 66, 700, 1_249, 2_500, 9_000];
  const CONTENTS: [string, (n: number) => string][] = [
    ["prose", prose],
    ["quiet", quiet],
  ];
  /** The exact append the `append at end` scenario above applies. */
  const SCENARIO_APPEND = " a new closing paragraph appended at the very end of the document.";

  it("LIVE CORPUS: set churn never exceeds the bound, per document and per append content", () => {
    const docs = repoDocs();
    // A bound assertion over an empty or single-document corpus is green by construction.
    expect(docs.length, "the corpus is too small for this assertion to mean anything").toBeGreaterThan(5);
    let tight = 0;
    let slack = 0;
    for (const t of docs) {
      const before = chunkContent(t);
      for (const len of APPEND_LENGTHS)
        for (const [name, make] of CONTENTS) {
          const after = chunkContent(t + make(len));
          const churn = changedCount(before, after);
          expect(churn, `${name} append of ${len} exceeded the bound`).toBeLessThanOrEqual(
            bound(before, after)
          );
          if (churn === bound(before, after)) tight++;
          else slack++;
        }
    }
    // REPORTED, not gated. Equality is what the swept corpus shows today (560/560), but a future
    // document quoting another one verbatim would legitimately come in under the bound, and reddening
    // CI on an unrelated docs edit is not what this rule is for. The DUPLICATE fixture gates the
    // inequality where it is deterministic.
    expect(tight + slack).toBeGreaterThan(0);
  });

  it("LIVE CORPUS: the ABSOLUTE ceiling holds — the guard that cannot self-adjust", () => {
    // This is the assertion a regressed chunker fails. Deliberately NOT a fitted constant: it is derived
    // from `CDC_PARAMS` and the append length. It is also LOOSE — see the ceiling test below, which
    // records what it does not catch rather than leaving that to be discovered.
    for (const t of repoDocs())
      for (const len of APPEND_LENGTHS)
        for (const [name, make] of CONTENTS) {
          const churn = changedCount(chunkContent(t), chunkContent(t + make(len)));
          expect(churn, `${name} append of ${len} passed the absolute ceiling`).toBeLessThanOrEqual(
            absoluteCeiling(len)
          );
        }
  });

  it("the absolute ceiling is DERIVED from the envelope, and its looseness is stated not hidden", () => {
    expect(DEPTH_CEILING).toBe(1 + Math.floor((CDC_PARAMS.max - 1) / CDC_PARAMS.min));
    expect(DEPTH_CEILING).toBe(4); // at the shipped 1,250/4,000 envelope
    // WHAT THIS DOES NOT CATCH, both reviewers independently: at a 60,000-character prose append the
    // corpus churns 23–24 against a ceiling of 4 + ceil(60000/1250) = 52, so a chunker that cut the
    // appended region at `min` instead of `target` would roughly DOUBLE every long append's cost and
    // still pass. Tight coverage exists only in the short-append regime (the envelope test below).
    expect(absoluteCeiling(60_000)).toBe(52);
  });

  it("LIVE CORPUS: divergence depth stays inside the DERIVED ceiling, not the observed maximum", () => {
    // The observed maximum is 2 on this corpus and 3 on the sweep's synthetic documents, so 2 is an
    // observation and asserting it would pin the corpus. `CDCCHURN-1` published a sparse-grid maximum as
    // if it were a bound; this asserts the derived 4 and reports the observation.
    let observed = 0;
    for (const t of repoDocs())
      for (const len of APPEND_LENGTHS)
        for (const [, make] of CONTENTS) {
          const b0 = cdcBoundaries(t, CDC_PARAMS);
          const b1 = cdcBoundaries(t + make(len), CDC_PARAMS);
          let l = 0;
          while (l < b0.length && l < b1.length && b0[l] === b1[l]) l++;
          const depth = b0.length - l;
          expect(depth, "an append moved more boundaries than the size envelope permits").toBeLessThanOrEqual(
            DEPTH_CEILING
          );
          observed = Math.max(observed, depth);
        }
    expect(observed, "no boundary moved at all — the assertion above ran on nothing").toBeGreaterThan(0);
  });

  it("CAPPED FIXTURE: the SHARED PREFIX must reach the cap — 'the document is past the cap' does not", () => {
    // The characterisation this fixture exists to kill was in the proposed replacement row, which would
    // have made it the fifth wrong answer shipping as documentation.
    const past = doc(400_000, 7);
    expect(cdcBoundaries(past, CDC_PARAMS).length).toBeGreaterThan(MAX_EPISODE_CHUNKS + 1);
    const beforePast = chunkContent(past);
    const afterPast = chunkContent(past + prose(2_500));
    expect(sharedPrefix(beforePast, afterPast)).toBe(MAX_EPISODE_CHUNKS);
    expect(changedCount(beforePast, afterPast), "a shared prefix at the cap must cost nothing").toBe(0);

    // …and the counter-case, which is the whole point: EXACTLY at the cap, churn is 1, not 0.
    const atCap = past.slice(0, 214_526);
    expect(
      cdcBoundaries(atCap, CDC_PARAMS).length,
      "the fixture drifted off the exact-cap boundary count it is built on"
    ).toBe(MAX_EPISODE_CHUNKS);
    const beforeAt = chunkContent(atCap);
    const afterAt = chunkContent(atCap + prose(2_500));
    expect(sharedPrefix(beforeAt, afterAt)).toBeLessThan(MAX_EPISODE_CHUNKS);
    expect(changedCount(beforeAt, afterAt), "a document AT the cap must not churn 0").toBeGreaterThan(0);
  });

  it("MERGE FIXTURE: a one-character append can DELETE a boundary", () => {
    // The backup-boundary preference is "the first backup hit at or after `target`, otherwise the first
    // backup hit at all" (lib/graph/cdc.ts). Extending the tail by one character extends the search
    // window by one; if that position satisfies the backup mask AND sits past `target`, it OUTRANKS the
    // earlier backup and the previous cut ceases to exist — two chunks merge into one.
    //
    // WHICH CHARACTER IS NOT INCIDENTAL. On the live document this was first observed against, `q`, `%`
    // and `5` delete the boundary while `x`, `a`, `z`, space, `.` and newline do not; the sweep's own
    // length-1 samples use `z` and `a` and so never saw the event. Checked in here rather than pinned to
    // live content for exactly that reason.
    const t = doc(30_000, 90);
    const before = cdcBoundaries(t, CDC_PARAMS);
    const after = cdcBoundaries(t + "#", CDC_PARAMS);
    expect(after.length, "the fixture stopped exercising the merge").toBe(before.length - 1);
    expect(before, "the vanishing boundary was not there to begin with").toContain(29_818);
    expect(after, "the boundary survived — the merge did not happen").not.toContain(29_818);
    // The bound holds through it, which is why the rule is stated against the shared prefix rather than
    // against the chunk count: the count went DOWN.
    const beforeChunks = chunkContent(t);
    const afterChunks = chunkContent(t + "#");
    expect(afterChunks.length).toBeLessThan(beforeChunks.length);
    expect(changedCount(beforeChunks, afterChunks)).toBeLessThanOrEqual(bound(beforeChunks, afterChunks));
  });

  it("DUPLICATE FIXTURE: set churn is STRICTLY below the bound — the rule is an inequality", () => {
    // The only branch that proves the rule is not an equality, and nothing on the live corpus reaches it.
    // `lib/graph/project.ts` filters by `new Set(chunk_shas)` MEMBERSHIP, so a re-cut chunk whose content
    // already exists anywhere in the document costs nothing.
    const t = doc(60_000, 21);
    const before = chunkContent(t);
    const after = chunkContent(t + t);
    expect(changedCount(before, after), "the fixture stopped exercising the inequality").toBeLessThan(
      bound(before, after)
    );
    // …and the positional count sits ON the bound, which is what makes the gap a metric difference
    // rather than a miscount.
    expect(positionalCount(before, after)).toBe(bound(before, after));
  });

  it("DUPLICATE, the other direction: appending an existing chunk VERBATIM saves nothing", () => {
    // Only a realignment that reproduces WHOLE chunks pays. Appending one existing chunk does not,
    // because the boundary shift means the re-cut chunks are not byte-identical to the original — so the
    // fixture above needs self-concatenation and a smaller duplicate would prove nothing.
    const t = doc(60_000, 22);
    const before = chunkContent(t);
    const after = chunkContent(t + before[5]);
    expect(changedCount(before, after)).toBe(bound(before, after));
  });

  it("WHITESPACE FIXTURE: the bound holds for a whitespace-only base — the case that killed the boundary form", () => {
    // `chunkCdc` returns [] for a whitespace-only body while `cdcBoundaries` still returns boundaries, so
    // stating the rule over BOUNDARY sequences gives a non-empty shared prefix over an EMPTY before-set.
    // Both spec reviewers produced this independently. In chunk coordinates the case is covered rather
    // than excluded: C0 = [], so L = 0 and the bound is |C1|.
    const t = " ".repeat(20_000);
    const before = chunkContent(t);
    const after = chunkContent(t + "x");
    expect(before, "the whitespace guard changed — this fixture is measuring something else now").toEqual([]);
    const churn = changedCount(before, after);
    expect(churn).toBe(6);
    expect(churn).toBeLessThanOrEqual(bound(before, after));
    // The refutation itself, pinned: the boundary-coordinate form would have said 1.
    const b0 = cdcBoundaries(t, CDC_PARAMS);
    const b1 = cdcBoundaries(t + "x", CDC_PARAMS);
    let l = 0;
    while (l < b0.length && l < b1.length && b0[l] === b1[l]) l++;
    const boundaryFormBound = Math.max(0, Math.min(MAX_EPISODE_CHUNKS, b1.length) - l);
    expect(churn, "the boundary-coordinate form is no longer refuted by this fixture").toBeGreaterThan(
      boundaryFormBound
    );
  });

  it("GROWTH FIXTURE: churn grows with append length AND differs with append content at the same length", () => {
    const t = doc(50_000, 3);
    const before = chunkContent(t);
    const churnOf = (make: (n: number) => string, len: number) =>
      changedCount(before, chunkContent(t + make(len)));
    const proseSeries = APPEND_LENGTHS.map((len) => churnOf(prose, len));
    for (let i = 1; i < proseSeries.length; i++)
      expect(proseSeries[i], `churn fell from ${APPEND_LENGTHS[i - 1]} to ${APPEND_LENGTHS[i]}`).toBeGreaterThanOrEqual(
        proseSeries[i - 1]
      );
    // No constant ceiling is asserted for any length — a ceiling is what made this row wrong four times.
    // A FLOOR at 9,000 is asserted instead, because "conditional on length" needs a test, not prose.
    expect(churnOf(prose, 9_000)).toBeGreaterThanOrEqual(4);
    // …and the same length under different content churns differently, which is the fifth thing the row
    // never mentioned: a hash-quiet run yields few cuts, so it becomes fewer chunks than prose does.
    expect(churnOf(quiet, 9_000)).toBeLessThan(churnOf(prose, 9_000));
  });

  it("ENVELOPE: for a short append CDC is at most ONE chunk worse than byte offsets, PER DOCUMENT", () => {
    // This REPLACES `max(cdc) <= max(legacy)` for this scenario rather than deleting it. That comparison
    // is not a property of appends: at the scenario's own 66-character append CDC is strictly worse than
    // byte offsets on 4 of 28 corpus documents, and it passes only because a FIFTH, unrelated document
    // churns 2 under legacy — max against max, across different documents. Its outcome also flips with
    // the appended content at a fixed length. Deleting it outright would leave no cross-algorithm guard
    // at all, which is what both spec reviewers refused.
    //
    // Scoped to appends shorter than `min`, where the +1 envelope is measured on BOTH the live corpus and
    // 300 synthetic documents. For longer appends the gap reaches +2 synthetically, so it is reported by
    // the sweep and not gated here — this file does not gate on a lower bound.
    const docs = repoDocs();
    expect(docs.length).toBeGreaterThan(5);
    let worse = 0;
    for (const t of docs)
      for (const len of APPEND_LENGTHS.filter((n) => n < CDC_PARAMS.min))
        for (const [name, make] of CONTENTS) {
          const app = make(len);
          const cdc = changedCount(chunkContent(t), chunkContent(t + app));
          const leg = changedCount(legacy(t), legacy(t + app));
          expect(cdc, `${name} append of ${len}: CDC is more than one chunk worse than byte offsets`).toBeLessThanOrEqual(
            leg + 1
          );
          if (cdc > leg) worse++;
        }
    // The trade is real and visible rather than asserted away: CDC IS worse than byte offsets on append.
    expect(worse, "no document is worse under CDC — the envelope is measuring nothing").toBeGreaterThan(0);
  });

  it("THE ROW'S OWN CLAIM: the scenario append does not churn a constant", () => {
    // Criterion 17. The design row may not carry an unconditional number, and the previous draft's
    // replacement text ("1 for a short append to a document below the cap") was refuted by exactly this
    // distribution — every one of those 2s is a below-cap document. Without this test that gloss passes
    // every other criterion in the spec.
    const distribution = new Map<number, number>();
    for (const t of repoDocs()) {
      const churn = changedCount(chunkContent(t), chunkContent(t + SCENARIO_APPEND));
      distribution.set(churn, (distribution.get(churn) ?? 0) + 1);
    }
    expect(distribution.size, "the scenario append churns one constant — the row could state it").toBeGreaterThan(1);
    expect(distribution.get(2) ?? 0, "no document churns 2 — 'always 1' would be defensible again").toBeGreaterThan(0);
    // The 0 comes from a document past the cap; if the corpus loses it, the cap branch of the row is no
    // longer exercised live and the CAPPED fixture is the only thing holding it.
    expect((distribution.get(0) ?? 0) + (distribution.get(1) ?? 0)).toBeGreaterThan(0);
  });
});
