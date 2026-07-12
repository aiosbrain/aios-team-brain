import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for `publication_analytics` (CLAUDE.md §2) — written only by
 * lib/social/analytics.ts. Fails the build if anything else writes it.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const OWNER = join("lib", "social", "analytics.ts");
const WRITE_RE = /from\(\s*["']publication_analytics["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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

describe("single-writer: publication_analytics table", () => {
  it("only lib/social/analytics.ts writes publication_analytics", () => {
    const hits: string[] = [];
    for (const d of ["app", "lib", "scripts"]) {
      for (const file of walk(join(ROOT, d))) {
        const rel = file.slice(ROOT.length + 1);
        if (rel === OWNER || rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
        for (const m of readFileSync(file, "utf8").matchAll(WRITE_RE)) hits.push(`${rel}: .${m[1]}(`);
      }
    }
    expect(hits.sort()).toEqual([]);
  });
});
