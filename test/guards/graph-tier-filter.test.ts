import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Graph tier-isolation guard (CLAUDE.md §5). The brain reads Graphiti's Neo4j graph DIRECTLY in a
 * small set of OWNED modules; Graphiti has no tier awareness, so EVERY Cypher query in those modules
 * must scope to a group term — the sole enforcement (no RLS backstop). This fails the build if any
 * Cypher block omits it. The real proof is the Neo4j tier test; this fails fast in review + catches a
 * new query that forgets the filter.
 *
 * GRAPHSAT-1 widened this from "learning only" to an owned-module list (the ownership comment had
 * been stale since extraction-health grew Cypher), and made the matcher strip Cypher comments first —
 * a `// … group_id IN $groups` comment satisfied the old regex (Codex design round 2 M3).
 *
 * `episode-lookup` DRIVES POSTGRES MUTATIONS (uuid backfill, re-queue) from what it reads, so its scope
 * term is a correctness AND isolation control; it uses equality on one group, not a viewer set.
 */

const OWNED: { file: string; term: RegExp; label: string }[] = [
  { file: "learning.ts", term: /group_id\s+IN\s+\$groups/, label: "group_id IN $groups" },
  { file: "episode-lookup.ts", term: /e\.group_id\s*=\s*\$g\b/, label: "e.group_id = $g" },
];

const graphDir = join(import.meta.dirname, "..", "..", "lib", "graph");

/** Strip Cypher/JS comments INSIDE a template literal before matching. */
export function stripCypherComments(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Extract every backtick template literal that contains a Cypher MATCH (comments stripped). Handles
 *  string-concatenated fragments too: any template literal containing MATCH counts as a block, and the
 *  module's whole concatenated Cypher is also joined so a term placed in a sibling fragment is seen. */
export function cypherBlocks(src: string): string[] {
  const literals = [...src.matchAll(/`([^`]*)`/g)].map((m) => stripCypherComments(m[1]));
  const blocks = literals.filter((b) => /\bMATCH\b/.test(b));
  return blocks;
}

describe("graph Cypher tier filter — every owned module, every query, comments stripped", () => {
  for (const { file, term, label } of OWNED) {
    it(`every Cypher query in lib/graph/${file} carries \`${label}\``, () => {
      const src = readFileSync(join(graphDir, file), "utf8");
      // Concatenated fragments: join adjacent template literals of one expression so a MATCH literal and
      // its WHERE literal are judged together (episode-lookup builds its query from fragments).
      const joined = src.replace(/`\s*\+\s*`/g, "");
      const blocks = cypherBlocks(joined);
      expect(blocks.length, `no Cypher blocks found in ${file} — guard would be vacuous`).toBeGreaterThan(0);
      const missing = blocks.filter((b) => !term.test(b));
      expect(missing, `Cypher query in ${file} without its group scope term (\`${label}\`):\n${missing.join("\n---\n")}`).toEqual([]);
    });
  }

  it("the matcher discriminates (non-vacuity)", () => {
    expect(cypherBlocks("const q = `MATCH (n) WHERE n.group_id IN $groups RETURN n`").length).toBe(1);
    expect(/group_id\s+IN\s+\$groups/.test("MATCH (n) RETURN n")).toBe(false);
  });

  it("a scope term that lives only in a COMMENT does not satisfy the guard", () => {
    const src = "const q = `// tier: group_id IN $groups\nMATCH (n) RETURN n`";
    const blocks = cypherBlocks(src);
    expect(blocks.length).toBe(1);
    expect(/group_id\s+IN\s+\$groups/.test(blocks[0])).toBe(false);
    const block2 = cypherBlocks("const q = `MATCH (n) /* e.group_id = $g */ RETURN n`")[0];
    expect(/e\.group_id\s*=\s*\$g\b/.test(block2)).toBe(false);
  });
});
