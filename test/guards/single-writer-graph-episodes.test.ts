import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard: `graph_episodes` (the Graphiti projection-state / idempotency table)
 * is written ONLY by `lib/graph` (the projector). Any other writer would break the
 * "re-project unchanged → no-op" guarantee. Fails the build on a foreign writer. Reads are fine.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "graph");
const WRITE_RE = /from\(\s*["']graph_episodes["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      if (rel.startsWith(OWNER)) continue;
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("graph_episodes").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: graph_episodes", () => {
  it("only lib/graph writes graph_episodes", () => {
    const violations = offenders();
    expect(violations, `graph_episodes written outside lib/graph:\n${violations.join("\n")}`).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    const W = () => new RegExp(WRITE_RE.source, "g");
    expect(W().test('db.from("graph_episodes").upsert(x)')).toBe(true);
    expect(W().test('db.from("graph_episodes").select("id")')).toBe(false);
  });
});
