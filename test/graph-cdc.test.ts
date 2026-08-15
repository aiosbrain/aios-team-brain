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
    if (name === "edit in place, same length") continue;
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
      // a boundary-disturbing 20-character in-place edit reaches **78 of 80 admitted chunks**
      // (`docs/ARCHITECTURE.md` @7111), against a legacy churn of 1. And "never worse than byte offsets"
      // is simply false for that scenario — byte offsets churn 1 by construction, since offsets do not
      // move. Both claims now live in the describe below, conditioned on what the edit actually touches.
      // The other scenarios still bind, and they are where CDC's win is real: the same corpus gives
      // CDC 5 against legacy 78 for an insertion near the top.
      if (name === "edit in place, same length") continue;
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
 * THE RULE, verified before it was written down — 5,658 unchanged-sequence samples swept across the
 * corpus at 97-character steps, 5,658 agreements, zero mismatches, under both this file's set-based
 * `changedCount` and a positional diff:
 *
 *   **churn = the number of ADMITTED chunk intervals the changed span intersects.**
 *
 * So exactly 1 needs two things together: the edit changes text, and it lies wholly inside one admitted
 * chunk. (A third condition — "no boundary strictly inside the edit span" — was specified and then
 * deleted as provably dead; see `classify`.) Anything else is reported, not gated — because when
 * the boundary sequence does change there is NO usable ceiling: the same sweep reaches **8 of 80**
 * admitted chunks for a 20-character edit (`docs/ARCHITECTURE.md` @181,517) against a legacy churn of
 * 1 — already past the ceiling of 6 this file used to assert. An earlier measurement reached 78 before
 * a merge changed that document, which is the live-corpus hazard in miniature: none of these numbers
 * gates anything, and the assertions below rest on the rule and the classification instead.
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
    // A DIRECTION, never a magnitude: the corpus already reaches 78 of 80, so any ceiling here would be
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
    expect(admittedIntervals(t).some(([lo, hi]) => at >= lo && at + EDIT_LEN <= hi)).toBe(true);
    expect(classify(t, at)).toBe("reported");
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
      expect(changedCount(chunkContent(t), chunkContent(inPlace(t))), "strict document churn").toBe(1);
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
