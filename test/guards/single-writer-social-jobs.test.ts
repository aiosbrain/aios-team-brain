import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the `social_jobs` table (CLAUDE.md §2). It is written ONLY by
 * `lib/jobs/store.ts` — the path that team-scopes every write and owns the claim/terminal
 * transitions. This test fails the build if any OTHER file inserts/updates/upserts/deletes
 * `social_jobs`, so the durable-queue invariant is structural, not a convention to remember.
 * (Reads are fine — the runner and a future admin panel only select.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [join("lib", "jobs", "store.ts")];
const WRITE_RE = /from\(\s*["']social_jobs["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("social_jobs").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: social_jobs table", () => {
  it("only lib/jobs/store.ts writes the social_jobs table", () => {
    const violations = offenders();
    expect(
      violations,
      `social_jobs written outside lib/jobs/store.ts (the single writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('db.from("social_jobs").update(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("social_jobs").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
