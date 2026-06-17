import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Codebase tier-isolation guard (CLAUDE.md §5). Codebase analytics are team-tier
 * only and there is NO RLS in postgres mode, so the app-code gate is the sole
 * enforcement. The existing dashboard guard only watches `items`, so codebase
 * reads need their own. This guard enforces two structural facts:
 *   (a) codebases dashboard PAGES never read the codebase tables directly — they
 *       go through lib/metrics/codebases (so the gate can't be skipped per-page);
 *   (b) that read helper itself applies the `canSeeCodebases(tier)` gate.
 * The real proof is the data-mechanics isolation test; this fails fast in review.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const PAGES_DIR = join(ROOT, "app", "t");
const HELPER = join(ROOT, "lib", "metrics", "codebases.ts");
const TABLES = /from\(\s*["'](codebases|code_metrics|code_contributions|github_issues)["']\s*\)/;

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
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("codebase tier isolation", () => {
  it("dashboard pages never read codebase tables directly (only via lib/metrics/codebases)", () => {
    const offenders = walk(PAGES_DIR)
      .filter((f) => TABLES.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(f.indexOf("app/")));
    expect(
      offenders,
      `Pages read codebase tables directly (no tier gate / no RLS backstop). ` +
        `Route reads through lib/metrics/codebases:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the read helper applies the canSeeCodebases tier gate", () => {
    const src = readFileSync(HELPER, "utf8");
    expect(src).toMatch(/canSeeCodebases\s*\(/);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(TABLES.test('supabase.from("code_metrics").select("x")')).toBe(true);
    expect(TABLES.test('supabase.from("items").select("x")')).toBe(false);
  });
});
