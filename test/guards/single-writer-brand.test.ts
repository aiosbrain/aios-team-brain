import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the `brand_profiles` table (CLAUDE.md §2). It is written ONLY by
 * `lib/brand/manage.ts` — the path that validates the config (allowlist + byte cap) and audits.
 * This test fails the build if any OTHER file inserts/updates/upserts/deletes `brand_profiles`,
 * so the invariant is structural. (Reads are fine — the admin page only selects.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [join("lib", "brand", "manage.ts")];
const WRITE_RE = /from\(\s*["']brand_profiles["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("brand_profiles").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: brand_profiles table", () => {
  it("only lib/brand/manage.ts writes the brand_profiles table", () => {
    const violations = offenders();
    expect(
      violations,
      `brand_profiles written outside lib/brand/manage.ts (the single writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('db.from("brand_profiles").upsert(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("brand_profiles").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
