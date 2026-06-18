import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the `integrations` table (CLAUDE.md §2). It is written ONLY by
 * `lib/integrations/manage.ts` — the path that validates the non-secret config (allowlist +
 * secret-key rejection + byte cap), sets updated_at, and audits. This test fails the build if
 * any OTHER file inserts/updates/upserts/deletes `integrations`, so the contract is structural.
 * (Reads are fine — the sidecar read API and the admin page only select.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [join("lib", "integrations", "manage.ts")];
const WRITE_RE = /from\(\s*["']integrations["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("integrations").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: integrations table", () => {
  it("only lib/integrations/manage.ts writes the integrations table", () => {
    const violations = offenders();
    expect(
      violations,
      `integrations written outside lib/integrations/manage.ts (the audited single writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('supabase.from("integrations").upsert(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('supabase.from("integrations").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
