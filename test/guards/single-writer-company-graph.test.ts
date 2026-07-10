import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the `graph_entities`/`graph_relationships` tables (CLAUDE.md §2). They
 * are written ONLY by `lib/graph/company-actors.ts` — the path that keeps member-derived actor
 * entities + REPORTS_TO edges in sync with the real roster. `scripts/seed-demo.ts`'s fictional
 * fixture data is the sole exemption (a demo/dev-only seed, pre-dating real member sync). This
 * test fails the build if any OTHER file inserts/updates/upserts/deletes either table, so the
 * contract is structural. (Reads are fine — `GET /api/v1/company-graph` and `lib/query/retrieve`
 * only select.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [
  join("lib", "graph", "company-actors.ts"),
  join("scripts", "seed-demo.ts"),
];
const WRITE_RE =
  /from\(\s*["'](graph_entities|graph_relationships)["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function offenders(): string[] {
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = file.slice(ROOT.length + 1);
      if (OWNERS.some((o) => rel === o)) continue;
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(WRITE_RE))
        hits.push(`${rel}: .from("${m[1]}").${m[2]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: graph_entities / graph_relationships", () => {
  it("only lib/graph/company-actors.ts (and the demo seed) writes the company graph tables", () => {
    const violations = offenders();
    expect(
      violations,
      `company graph tables written outside lib/graph/company-actors.ts (the audited single writer):\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('db.from("graph_entities").upsert(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("graph_relationships").delete(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("graph_entities").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
