import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for `social_publications` (CLAUDE.md §2) — the publish ledger, written only
 * by lib/social/publications.ts. Fails the build if anything else writes it.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [join("lib", "social", "publications.ts")];
const WRITE_RE = /from\(\s*["']social_publications["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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

describe("single-writer: social_publications table", () => {
  it("only lib/social/publications.ts writes social_publications", () => {
    const hits: string[] = [];
    for (const d of SCAN_DIRS) {
      for (const file of walk(join(ROOT, d))) {
        const rel = file.slice(ROOT.length + 1);
        if (OWNERS.some((o) => rel === o)) continue;
        if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
        for (const m of readFileSync(file, "utf8").matchAll(WRITE_RE)) hits.push(`${rel}: .${m[1]}(`);
      }
    }
    expect(hits.sort()).toEqual([]);
  });
});
