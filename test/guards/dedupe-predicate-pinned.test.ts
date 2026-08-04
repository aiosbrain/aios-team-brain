import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveDedupePollution,
  MIN_EDGES_FOR_DEDUPE_SIGNAL,
} from "@/lib/graph/extraction-health";

/**
 * GUARD: the dedupe-pollution alarm's Cypher predicate must stay pinned to what Graphiti actually
 * writes (AIO-693 spec, guard #1).
 *
 * The failure mode: a Graphiti upgrade renames `IS_DUPLICATE_OF` (or moves it off `RELATES_TO`), the
 * query silently matches nothing, shares fall to zero, and the alarm dies without a sound — worse, an
 * ACTIVE alarm would mail "recovered" mid-incident. Two layers, because neither alone covers both
 * sides:
 *
 *  1. OUR side (this file): the query text in `dedupeSignals` must still say what the deployed image
 *     (zepai/graphiti@76d14f30, graphiti_core 0.13.2 — verified 2026-08-03) actually writes. A
 *     refactor that rewords the predicate fails the build.
 *  2. GRAPHITI's side (runtime, `deriveDedupePollution`): a zero-dupe baseline over a ≥MIN-edge
 *     window is treated as predicate-suspect and UNJUDGEABLE — this graph's measured healthy
 *     baseline is ~26–35%, so a literal zero means the relation is gone, not that extraction became
 *     perfect. That check is asserted here so it can't be simplified away.
 */
describe("dedupe predicate pinning", () => {
  const src = readFileSync(join(process.cwd(), "lib/graph/extraction-health.ts"), "utf8");

  it("the signal query still greps the relation Graphiti actually writes", () => {
    expect(src).toContain("MATCH ()-[r:RELATES_TO]->()");
    expect(src).toContain("r.name = 'IS_DUPLICATE_OF'");
    // Extraction time, not `valid_at` — Graphiti backdates valid_at to the episode's WORK time, so a
    // backfill would otherwise be judged by its content's age instead of what the extractor just did.
    expect(src).toContain("r.created_at");
    expect(src.includes("r.valid_at")).toBe(false);
  });

  it("a zero-dupe baseline over a real sample is unjudgeable, not perfectly healthy", () => {
    const out = deriveDedupePollution({
      recentTotal: MIN_EDGES_FOR_DEDUPE_SIGNAL * 4,
      recentDupe: MIN_EDGES_FOR_DEDUPE_SIGNAL * 2, // 50% recent — would alarm against any real baseline
      baselineTotal: MIN_EDGES_FOR_DEDUPE_SIGNAL * 4,
      baselineDupe: 0, // ...but a literal-zero baseline means the predicate matched nothing
    });
    expect(out.judgeable).toBe(false);
    expect(out.polluted).toBe(false);
  });
});
