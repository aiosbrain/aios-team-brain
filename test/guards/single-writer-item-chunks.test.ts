import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the optional dense-retrieval table `item_chunks` (CLAUDE.md §2). It is
 * written ONLY by `lib/query/dense-index.ts` — the path that chunks/embeds and mirrors `items.access`
 * onto each chunk (so dense hits stay tier-filterable). This fails the build if anything else writes
 * it, via the builder (`.from("item_chunks").insert/update/upsert/delete`) OR raw SQL
 * (`insert into item_chunks` / `update item_chunks` / `delete from item_chunks`). Reads are fine.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "query", "dense-index.ts");
const BUILDER_RE = /from\(\s*["']item_chunks["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;
const RAW_RE = /\b(insert\s+into|update|delete\s+from)\s+item_chunks\b/gi;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx") || p.endsWith(".mjs")) out.push(p);
  }
  return out;
}

function offenders(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = file.slice(ROOT.length + 1);
      if (rel === OWNER) continue;
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(BUILDER_RE)) hits.push(`${rel}: .from("item_chunks").${m[1]}(`);
      for (const m of src.matchAll(RAW_RE)) hits.push(`${rel}: ${m[1]} item_chunks`);
    }
  }
  return hits.sort();
}

describe("single-writer: item_chunks table", () => {
  it("only lib/query/dense-index.ts writes item_chunks", () => {
    const violations = offenders();
    expect(
      violations,
      `item_chunks written outside lib/query/dense-index.ts (the single writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matchers discriminate writes from reads (non-vacuity)", () => {
    expect(RAW_RE.test("insert into item_chunks (a) values (1)")).toBe(true);
    RAW_RE.lastIndex = 0;
    expect(RAW_RE.test("delete from item_chunks where item_id = $1")).toBe(true);
    RAW_RE.lastIndex = 0;
    expect(RAW_RE.test("select content from item_chunks where team_id = $1")).toBe(false);
    RAW_RE.lastIndex = 0;
    expect(BUILDER_RE.test('db.from("item_chunks").insert(')).toBe(true);
    BUILDER_RE.lastIndex = 0;
  });
});
