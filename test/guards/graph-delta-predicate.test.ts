import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    src.indexOf(";", src.indexOf("existingRow.chunk_config === CHUNK_CONFIG"))
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
    ["same chunk config (AC11)", "chunk_config === CHUNK_CONFIG"],
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
