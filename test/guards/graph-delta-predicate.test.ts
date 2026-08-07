import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  CHUNK_CONFIG,
  chunkConfigDeltaCompatible,
  chunkContentLegacy,
  chunkContentUnderConfig,
  storedChunkingComplete,
} from "@/lib/graph/project";

/**
 * GRAPHCOST-1 — the delta path's entry predicate is conjunctive, and every term is load-bearing.
 *
 * The behavioural proof lives in `test/datamechanics/graph-chunk-delta.datamechanics.test.ts`: deleting
 * any one term reddens exactly one acceptance criterion (AC5 tier, AC6 retention, AC7 pending cleanup,
 * AC10 sentinel, AC11 chunk config — each mutation-verified). Those tests are the real check.
 *
 * This guard exists for the one thing they cannot catch: a change that deletes a term AND the test that
 * covers it in the same diff. It is deliberately a source-shape assertion, which is weaker evidence than
 * an outcome — so it is scoped to exactly that, and the comment says which test carries the real weight.
 *
 * The sentinel term is the one worth naming here. `reconcile` re-queues a never-landed row by setting
 * `content_sha256 = ''` and nothing else; its cleanup loop later clears the pending flag while leaving
 * that sentinel in place. Without the term, the delta finds every hash already recorded, pushes nothing,
 * and the item's content never returns to the graph while the ledger reads healthy every hour.
 */
describe("graph delta predicate — every term present", () => {
  const src = readFileSync(join(process.cwd(), "lib/graph/project.ts"), "utf8");
  const predicate = src.slice(
    src.indexOf("const deltaEligible ="),
    src.indexOf(";", src.indexOf("chunkConfigDeltaCompatible(existingRow.chunk_config, CHUNK_CONFIG)"))
  );

  it("reads the predicate it is guarding (fails loudly if the shape moved)", () => {
    expect(predicate).toContain("const deltaEligible =");
    expect(predicate.length).toBeGreaterThan(50);
    expect(predicate.length).toBeLessThan(1_000); // a whole-file slice would make every check below pass
  });

  const terms: [name: string, term: string][] = [
    ["retention rule (AC6)", "retainSupersededBodies"],
    ["same group (AC5)", "!tierChanged"],
    ["no cleanup outstanding on any group (AC7)", "pending_delete_group_id === null"],
    ["live projection, not a reconcile sentinel (AC10)", 'content_sha256 !== ""'],
    // AIO-808: the literal equality became a helper call, because a RAISED cap leaves stored hashes
    // valid. The term is still one conjunct — the `||` lives inside the helper, so the no-`||`
    // assertion below survives rather than being weakened to accommodate the change.
    ["trustworthy chunk config (AC11)", "chunkConfigDeltaCompatible(existingRow.chunk_config, CHUNK_CONFIG)"],
  ];

  for (const [name, term] of terms) {
    it(`requires the ${name}`, () => {
      expect(predicate).toContain(term);
    });
  }

  it("is a conjunction — one `&&` per term boundary, no `||` smuggled in", () => {
    expect(predicate).not.toContain("||");
    expect(predicate.split("&&").length - 1).toBeGreaterThanOrEqual(terms.length - 1);
  });
});

/**
 * The OTHER site — the composite unchanged-content skip, which PIPEFF-3 WIDENED rather than replaced.
 *
 * The widening is the one shape where a source-level guard earns its keep: the third case introduces
 * the file's only `||` at a skip, and the whole argument for it being safe is that the surrounding
 * conjunction is inherited. A refactor that hoisted `provablyComplete` out of that conjunction — say,
 * skipping on completeness alone — would leak a re-queued sentinel row past the skip and silently drop
 * its content from the graph forever. The behavioural proof is the mutation-verified data-mechanics
 * suite; this catches the diff that deletes a term AND its test together.
 */
describe("the composite skip — the third case is a widening, not a new site", () => {
  const src = readFileSync(join(process.cwd(), "lib/graph/project.ts"), "utf8");
  // Comments stripped: the block's own prose NAMES the inherited terms (it has to — that is the whole
  // argument for the widening being safe), and counting occurrences across prose would make every
  // assertion below satisfiable by a sentence.
  const skip = src
    .slice(src.indexOf("    const boundariesTrustworthy ="), src.indexOf("// NO BACKFILL HERE ANY MORE"))
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

  it("reads the block it is guarding (fails loudly if the shape moved)", () => {
    expect(skip).toContain("const boundariesTrustworthy =");
    expect(skip).toContain("boundariesTrustworthy ||");
    expect(skip).toContain("storedChunkingComplete({");
    expect(skip.length).toBeLessThan(2_500);
  });

  for (const term of ["!tierChanged", "!purgeBeforeRepush", "existingRow.content_sha256 === contentSha"]) {
    it(`the completeness case sits INSIDE the conjunction that owns ${term}`, () => {
      // EXACTLY ONE occurrence, and the completeness call after it. A second copy inside a separate
      // `provablyComplete` const is what the first draft had, and mutation testing proved every one of
      // those copies deletable with the suite still green — the "term no test can redden" shape.
      expect(skip.split(term).length - 1, `${term} must appear exactly once`).toBe(1);
      expect(skip.indexOf(term), `${term} must be evaluated before storedChunkingComplete`).toBeLessThan(
        skip.indexOf("storedChunkingComplete({")
      );
    });
  }

  it("completeness is asked about the STORED config and the STORED hashes, never the current ones", () => {
    expect(skip).toContain("storedConfig: existingRow.chunk_config");
    expect(skip).toContain("storedShas: existingRow.chunk_shas");
    expect(skip).not.toContain("storedConfig: CHUNK_CONFIG");
  });

  it("the re-chunk is behind the `||`, so the cheap terms short-circuit it", () => {
    // `storedChunkingComplete` re-chunks the whole body. Hoisting it out of the short-circuit would run
    // a full re-chunk of every item on every tick, including the ~40% of the corpus that is a single
    // sub-minimum chunk — a real cost with no behavioural test to catch it.
    expect(skip.indexOf("boundariesTrustworthy ||")).toBeLessThan(skip.indexOf("storedChunkingComplete({"));
  });
});

/**
 * The helper the predicate now delegates to (AIO-808, extended for `cdc1` by PIPEFF-3). Its whole job
 * is one asymmetry: a raised CAP leaves every earlier chunk byte-identical (the cap is not an input to
 * boundary computation in EITHER algorithm — it only truncates the emitted sequence), while a changed
 * SIZE parameter moves every boundary. Getting that backwards costs either 689,235 characters that
 * never enter the graph, or a full re-extraction of the corpus.
 */
describe("chunkConfigDeltaCompatible — can the stored hashes still be trusted?", () => {
  it("same config — today's normal path, in both algorithms", () => {
    expect(chunkConfigDeltaCompatible("2500x40", "2500x40")).toBe(true);
    expect(chunkConfigDeltaCompatible(CHUNK_CONFIG, CHUNK_CONFIG)).toBe(true);
    expect(chunkConfigDeltaCompatible("cdc1-2500-1250-4000-80", "cdc1-2500-1250-4000-80")).toBe(true);
  });

  it("CDC identical is the STEADY STATE — without it the insertion cascade survives CDC untouched", () => {
    // The omission that would have shipped this lever as a no-op: the old parser was /^(\d+)x(\d+)$/,
    // which returns false for any CDC string INCLUDING stored === current. An edit to a CDC item would
    // then fail delta eligibility, `alreadyPushed` would be empty, and every chunk would full-re-push —
    // the cascade, now wearing content-defined boundaries. The pure-function churn table stays green
    // through all of that, which is why the real gate is the data-mechanics acceptance.
    expect(chunkConfigDeltaCompatible(CHUNK_CONFIG, CHUNK_CONFIG)).toBe(true);
  });

  it("cap GREW — trustworthy in both algorithms, and this is the case worth the whole helper", () => {
    // The stored 16 hashes still identify chunks 0..15 exactly; only the tail is new.
    expect(chunkConfigDeltaCompatible("2500x16", "2500x40")).toBe(true);
    expect(chunkConfigDeltaCompatible("cdc1-2500-1250-4000-80", "cdc1-2500-1250-4000-120")).toBe(true);
  });

  it("cap SHRANK — NOT trustworthy: chunks past the new cap become untracked orphans", () => {
    expect(chunkConfigDeltaCompatible("2500x40", "2500x16")).toBe(false);
    expect(chunkConfigDeltaCompatible("cdc1-2500-1250-4000-120", "cdc1-2500-1250-4000-80")).toBe(false);
    // NB this is "I cannot vouch for the ledger", NOT "re-push". PIPEFF-3 decided cap-shrink explicitly:
    // a body-unchanged item that verifies COMPLETE under its stored, larger cap is left alone by the
    // composite skip. `storedChunkingComplete` is what expresses that, not this helper.
  });

  it("any SIZE parameter differing — not trustworthy, whichever direction, because boundaries moved", () => {
    expect(chunkConfigDeltaCompatible("1000x64", "2500x40")).toBe(false);
    expect(chunkConfigDeltaCompatible("2500x40", "1000x64")).toBe(false);
    // Same cap, different chars: the cap comparison alone would wrongly pass this.
    expect(chunkConfigDeltaCompatible("1000x40", "2500x40")).toBe(false);
    // …and one CDC parameter at a time, so no single term can be dropped unnoticed.
    for (const stored of [
      "cdc1-2000-1250-4000-80", // target
      "cdc1-2500-1000-4000-80", // min
      "cdc1-2500-1250-5000-80", // max
    ]) {
      expect(chunkConfigDeltaCompatible(stored, "cdc1-2500-1250-4000-80"), stored).toBe(false);
    }
  });

  it("ACROSS ALGORITHMS — never compatible, however similar the numbers look", () => {
    // The rollout case. `2500x40` and `cdc1-2500-...` share a target size and share no boundary; a
    // helper that let this through would treat legacy hashes as identifying CDC chunks and silently
    // withhold every chunk of every migrating item from the graph.
    expect(chunkConfigDeltaCompatible("2500x40", CHUNK_CONFIG)).toBe(false);
    expect(chunkConfigDeltaCompatible(CHUNK_CONFIG, "2500x40")).toBe(false);
    expect(chunkConfigDeltaCompatible("2500x80", "cdc1-2500-1250-4000-80")).toBe(false);
  });

  it("the ASSUMPTION the helper rests on: a raised cap APPENDS, it never rewrites — LEGACY", () => {
    // If this were ever false, `cap grew ⇒ trustworthy` would be silent graph corruption rather than a
    // saving — the stored hashes would identify chunks whose content had moved. Asserted directly
    // rather than trusted, because the whole feature is downstream of it.
    const text = Array.from({ length: 2500 * 20 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const small = chunkContentLegacy(text, 2500, 16);
    const large = chunkContentLegacy(text, 2500, 40);
    expect(small).toHaveLength(16);
    expect(large.length).toBeGreaterThan(16);
    expect(large.slice(0, 16), "the first 16 chunks must be byte-identical").toEqual(small);
    // …and a CHARS change does move them, which is why that case is incompatible.
    expect(chunkContentLegacy(text, 1250, 16)[0]).not.toEqual(small[0]);
  });

  it("the same assumption for CDC — pinned in test/graph-cdc.test.ts, restated here as a smoke check", () => {
    // The CDC version needs a fixture that actually REACHES the cap, which is 200K+ of prose; the full
    // treatment (including "the final permitted chunk is not special-cased") lives in the CDC suite.
    // This restates the shape so the helper's two branches are both anchored to a behaviour.
    const text = readFileSync(join(process.cwd(), "docs/ARCHITECTURE.md"), "utf8");
    const atSmallCap = chunkContentUnderConfig(text, "cdc1-2500-1250-4000-20") ?? [];
    const atLargeCap = chunkContentUnderConfig(text, "cdc1-2500-1250-4000-60") ?? [];
    expect(atSmallCap).toHaveLength(20);
    expect(atLargeCap.length).toBeGreaterThan(20);
    expect(atLargeCap.slice(0, 20)).toEqual(atSmallCap);
  });

  it("malformed, empty or absent — NEVER 'compatible'", () => {
    // `""` is a real stored value (a dm fixture writes exactly that), and a row can predate the
    // column. An unparseable config must read as "I cannot vouch for these hashes".
    for (const junk of ["", "  ", null, undefined, "2500", "x40", "2500x", "abcxdef", "0x40", "2500x0", "2500x40x2"]) {
      expect(chunkConfigDeltaCompatible(junk, "2500x40"), `stored=${JSON.stringify(junk)}`).toBe(false);
    }
    expect(chunkConfigDeltaCompatible("2500x40", "")).toBe(false);
    for (const junk of [
      "cdc1",
      "cdc1-2500",
      "cdc1-2500-1250-4000",
      "cdc1-2500-1250-4000-80-1",
      "cdc2-2500-1250-4000-80", // a DIFFERENT algorithm generation must not read as cdc1
      "cdc1-0-1250-4000-80",
      "cdc1-2500-1250-4000-0",
      "cdc1-2500-1250-4000-80 ",
    ]) {
      expect(chunkConfigDeltaCompatible(junk, CHUNK_CONFIG), `stored=${JSON.stringify(junk)}`).toBe(
        junk === "cdc1-2500-1250-4000-80 " // a trailing space is trimmed, not rejected
      );
    }
  });
});

/**
 * PIPEFF-3, the third case: "boundaries stale, but the item is provably complete ⇒ leave it alone".
 *
 * This is the whole lazy rollout. Get it too LOOSE and CDC permanently re-strands the population
 * CHUNKCAP-1 existed to un-strand (an item clipped at its old cap looks "complete under the stored
 * config" if you only count hashes). Get it too STRICT and the corpus full-re-pushes for ~$76 of text
 * we already have.
 */
describe("storedChunkingComplete — the four conditions, one at a time", () => {
  const hash = (s: string) => createHash("sha256").update(s).digest("hex");
  const body = Array.from({ length: 25_000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  const complete = {
    body,
    storedConfig: "2500x40",
    storedShas: chunkContentLegacy(body, 2500, 40).map(hash),
    hash,
  };

  it("the happy case — a legacy row whose 10 chunks cover the whole body is COMPLETE", () => {
    expect(complete.storedShas).toHaveLength(10);
    expect(storedChunkingComplete(complete)).toBe(true);
  });

  it("(1) re-chunks under the STORED config, not the current one", () => {
    // The bug this term prevents is silent: re-chunking under `CHUNK_CONFIG` would compare CDC chunks
    // to legacy hashes, find no match, and full-re-push every legacy row on the corpus — the exact
    // ~$76 event the lazy rollout exists to avoid. Shown by a config whose numbers differ.
    expect(storedChunkingComplete({ ...complete, storedConfig: "1000x40" })).toBe(false);
    expect(chunkContentUnderConfig(body, "2500x40")).not.toEqual(chunkContentUnderConfig(body, "1000x40"));
  });

  it("(2) requires ELEMENT-WISE hash equality, not count equality", () => {
    // A count-only check is satisfied by any 10 hashes. Swapping two adjacent entries keeps the count,
    // the multiset, and the config — and means the ledger describes a different document order.
    const swapped = [...complete.storedShas];
    [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
    expect(swapped).toHaveLength(complete.storedShas.length);
    expect(storedChunkingComplete({ ...complete, storedShas: swapped })).toBe(false);
    // …and a single altered hash, which a set-membership check would also miss if it counted matches.
    const altered = [...complete.storedShas];
    altered[7] = hash("something that was never a chunk of this body");
    expect(storedChunkingComplete({ ...complete, storedShas: altered })).toBe(false);
  });

  it("(3) requires the re-chunk to have CONSUMED THE WHOLE BODY — a clipped item is NOT complete", () => {
    // THE hole. An item over its stored cap re-chunks to exactly `cap` chunks that all hash correctly,
    // so terms 1, 2 and 4 all pass while the item still owes every character past the cap. Leaving it
    // alone would re-strand it forever — the population CHUNKCAP-1 was built to rescue.
    const huge = body.repeat(6); // 150,000 chars — 60 chunks, well past a cap of 40
    const clipped = chunkContentLegacy(huge, 2500, 40);
    expect(clipped).toHaveLength(40);
    expect(clipped.join("").length).toBeLessThan(huge.length);
    expect(
      storedChunkingComplete({ body: huge, storedConfig: "2500x40", storedShas: clipped.map(hash), hash })
    ).toBe(false);
  });

  it("(3) is the EXACT answer, not the arithmetic proxy — a big body fully covered under the cap passes", () => {
    // The proxy an earlier draft used (`storedMin x storedCap >= body.length`) is sufficient but not
    // necessary: it would condemn a 150K body fully covered in 60 of 80 chunks to a pointless full
    // re-extraction at every future config change. `60 < 80` is the free, correct answer.
    const huge = body.repeat(6);
    const covered = chunkContentLegacy(huge, 2500, 80);
    expect(covered).toHaveLength(60);
    expect(
      storedChunkingComplete({ body: huge, storedConfig: "2500x80", storedShas: covered.map(hash), hash })
    ).toBe(true);
  });

  it("(4) an empty or unparseable chunk_config is NEVER complete", () => {
    // Mutation note, recorded because it changes what a green here means: (4) is enforced at TWO
    // points — the explicit `if (!parsed) return false` and `chunkContentUnderConfig` returning null
    // for the same input. Deleting only the first leaves this test green. The mutation that reddens it
    // is at the shared root: `parseChunkConfig` falling back to a default instead of refusing, which is
    // the bug shape that matters ("an empty config means the current one").
    for (const cfg of ["", "   ", null, undefined, "garbage", "cdc2-2500-1250-4000-80"]) {
      expect(storedChunkingComplete({ ...complete, storedConfig: cfg }), `config=${cfg}`).toBe(false);
    }
    // …and an empty ledger attests nothing, whatever the config says.
    expect(storedChunkingComplete({ ...complete, storedShas: [] })).toBe(false);
    expect(storedChunkingComplete({ ...complete, storedShas: null })).toBe(false);
  });

  it("a CDC row is complete under its own config — the steady state, and cap-shrink's answer", () => {
    const cdcShas = (chunkContentUnderConfig(body, CHUNK_CONFIG) ?? []).map(hash);
    expect(cdcShas.length).toBeGreaterThan(1);
    expect(storedChunkingComplete({ body, storedConfig: CHUNK_CONFIG, storedShas: cdcShas, hash })).toBe(true);
    // Cap-shrink: stored under a LARGER cap, current is smaller. `chunkConfigDeltaCompatible` says
    // "cannot vouch", and this says "complete" — which is what leaves the item alone (PIPEFF-3's
    // explicit decision, replacing the comment that documented a full re-push).
    const wideShas = (chunkContentUnderConfig(body, "cdc1-2500-1250-4000-120") ?? []).map(hash);
    expect(chunkConfigDeltaCompatible("cdc1-2500-1250-4000-120", CHUNK_CONFIG)).toBe(false);
    expect(
      storedChunkingComplete({ body, storedConfig: "cdc1-2500-1250-4000-120", storedShas: wideShas, hash })
    ).toBe(true);
  });
});
