import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkConfigDeltaCompatible, chunkContent } from "@/lib/graph/project";

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
 * The helper the predicate now delegates to (AIO-808). Its whole job is one asymmetry: a raised CAP
 * leaves every earlier chunk byte-identical (chunking is `slice(i, i+chars)` stepping by `chars`, so
 * the cap only truncates the sequence), while a changed CHARS moves every boundary. Getting that
 * backwards costs either 689,235 characters that never enter the graph, or a $47 full re-extraction.
 */
describe("chunkConfigDeltaCompatible — can the stored hashes still be trusted?", () => {
  it("same config — today's normal path", () => {
    expect(chunkConfigDeltaCompatible("2500x40", "2500x40")).toBe(true);
  });

  it("cap GREW — trustworthy, and this is the case worth the whole feature", () => {
    // The stored 16 hashes still identify chunks 0..15 exactly; only the tail is new.
    expect(chunkConfigDeltaCompatible("2500x16", "2500x40")).toBe(true);
  });

  it("cap SHRANK — NOT trustworthy: chunks past the new cap become untracked orphans", () => {
    expect(chunkConfigDeltaCompatible("2500x40", "2500x16")).toBe(false);
  });

  it("CHARS differ — not trustworthy, whichever direction, because every boundary moved", () => {
    expect(chunkConfigDeltaCompatible("1000x64", "2500x40")).toBe(false);
    expect(chunkConfigDeltaCompatible("2500x40", "1000x64")).toBe(false);
    // Same cap, different chars: the cap comparison alone would wrongly pass this.
    expect(chunkConfigDeltaCompatible("1000x40", "2500x40")).toBe(false);
  });

  it("the ASSUMPTION the helper rests on: a raised cap APPENDS, it never rewrites", () => {
    // If this were ever false, `cap grew ⇒ trustworthy` would be silent graph corruption rather than a
    // saving — the stored hashes would identify chunks whose content had moved. Asserted directly
    // rather than trusted, because the whole feature is downstream of it.
    const text = Array.from({ length: 2500 * 20 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
    const small = chunkContent(text, 2500, 16);
    const large = chunkContent(text, 2500, 40);
    expect(small).toHaveLength(16);
    expect(large.length).toBeGreaterThan(16);
    expect(large.slice(0, 16), "the first 16 chunks must be byte-identical").toEqual(small);
    // …and a CHARS change does move them, which is why that case is incompatible.
    expect(chunkContent(text, 1250, 16)[0]).not.toEqual(small[0]);
  });

  it("malformed, empty or absent — NEVER 'compatible'", () => {
    // `""` is a real stored value (a dm fixture writes exactly that), and a row can predate the
    // column. An unparseable config must read as "I cannot vouch for these hashes".
    for (const junk of ["", "  ", null, undefined, "2500", "x40", "2500x", "abcxdef", "0x40", "2500x0", "2500x40x2"]) {
      expect(chunkConfigDeltaCompatible(junk, "2500x40"), `stored=${JSON.stringify(junk)}`).toBe(false);
    }
    expect(chunkConfigDeltaCompatible("2500x40", "")).toBe(false);
  });
});
