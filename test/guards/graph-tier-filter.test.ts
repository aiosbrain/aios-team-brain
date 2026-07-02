import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Graph tier-isolation guard (CLAUDE.md §5). The Brain-Learning panel reads Graphiti's Neo4j graph
 * directly; Graphiti has no tier awareness, so EVERY Cypher query in `lib/graph/learning` must scope
 * to the caller's visible groups via `group_id IN $groups` — the sole enforcement (no RLS backstop).
 * This fails the build if any Cypher block omits it. The real proof is the Neo4j data-mechanics test;
 * this fails fast in review + catches a new query that forgets the filter.
 */

const LEARNING = join(import.meta.dirname, "..", "..", "lib", "graph", "learning.ts");

/** Extract every backtick template literal that contains a Cypher MATCH. */
function cypherBlocks(src: string): string[] {
  return [...src.matchAll(/`([^`]*\bMATCH\b[^`]*)`/g)].map((m) => m[1]);
}

describe("graph learning tier filter", () => {
  it("every Cypher query in lib/graph/learning filters group_id IN $groups", () => {
    const src = readFileSync(LEARNING, "utf8");
    const blocks = cypherBlocks(src);
    expect(blocks.length, "no Cypher blocks found — guard would be vacuous").toBeGreaterThan(0);
    const missing = blocks.filter((b) => !/group_id\s+IN\s+\$groups/.test(b));
    expect(
      missing,
      `Cypher query without a group_id tier filter (external could read team facts):\n${missing.join("\n---\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(cypherBlocks("const q = `MATCH (n) WHERE n.group_id IN $groups RETURN n`").length).toBe(1);
    expect(/group_id\s+IN\s+\$groups/.test("MATCH (n) RETURN n")).toBe(false);
  });
});
