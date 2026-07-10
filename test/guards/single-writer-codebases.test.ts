import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for codebase analytics (CLAUDE.md §2). `codebases`,
 * `code_metrics`, `code_contributions`, and `github_issues` are written ONLY by the
 * sanctioned, audited paths: `lib/codebases/*` (ingest, behind POST /api/v1/codebases)
 * and `lib/admin/aliases.ts` (the audited alias remap, which sets
 * `code_contributions.member_id` and is itself guarded by the data-mechanics
 * collision tests). This test fails the build if any OTHER file inserts/updates/
 * upserts/deletes them, so the contract is enforced by structure. (Reads are fine.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
// Sanctioned writers (audited): the ingest path + the alias remap.
const OWNERS = [join("lib", "codebases"), join("lib", "admin", "aliases.ts")];
const TABLES = "codebases|code_metrics|code_contributions|github_issues";
const WRITE_RE = new RegExp(
  `from\\(\\s*["'](${TABLES})["']\\s*\\)\\s*\\.\\s*(insert|update|upsert|delete)\\b`,
  "g"
);

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
      if (OWNERS.some((o) => rel.startsWith(o))) continue; // sanctioned writers
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(WRITE_RE)) {
        hits.push(`${rel}: .from("${m[1]}").${m[2]}(`);
      }
    }
  }
  return hits.sort();
}

describe("single-writer: codebase analytics tables", () => {
  it("only the sanctioned paths (lib/codebases, lib/admin/aliases) write the codebase tables", () => {
    const violations = offenders();
    expect(
      violations,
      `Codebase tables written outside lib/codebases (the audited single writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('db.from("code_metrics").upsert(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("code_metrics").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
