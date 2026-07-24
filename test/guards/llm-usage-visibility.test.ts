import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * llm_usage row-scoping guard (CLAUDE.md §5). In postgres mode there is no RLS, so any read of
 * `llm_usage` that renders to a viewer MUST scope rows in app code via `scopeLlmUsage` — a non-admin
 * sees only spend THEY initiated, an admin sees the team (incl. null-member background). Same bug
 * class as the earlier `query_log` leak; this fails the build if a dashboard page or metrics module
 * reads `llm_usage` without scoping, so a new cost surface can't leak another member's/background
 * spend. A genuinely viewer-agnostic read (e.g. a cron aggregate) may opt out with
 * `// llm-usage-scope-ok: <reason>`.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = [join(ROOT, "app", "t"), join(ROOT, "lib", "metrics")];
const SCOPE = /scopeLlmUsage\s*\(/;
const READS_LLM_USAGE = /from\(\s*["']llm_usage["']\s*\)/;
const OPT_OUT = /llm-usage-scope-ok:/;

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

function offenders(): string[] {
  const hits: string[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(dir)) {
      const src = readFileSync(file, "utf8");
      if (!READS_LLM_USAGE.test(src)) continue;
      if (OPT_OUT.test(src)) continue;
      if (!SCOPE.test(src)) hits.push(file.slice(file.indexOf("aios-team-brain/") + "aios-team-brain/".length));
    }
  }
  return hits.sort();
}

describe("llm_usage row-level visibility", () => {
  it("every dashboard/metrics read of llm_usage scopes rows by member/role", () => {
    const violations = offenders();
    expect(
      violations,
      `Reads of llm_usage without scopeLlmUsage (no RLS backstop in postgres mode):\n` +
        `Route the read through scopeLlmUsage() (or // llm-usage-scope-ok: <reason>):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matchers discriminate (non-vacuity)", () => {
    expect(READS_LLM_USAGE.test('db.from("llm_usage").select("cost_usd")')).toBe(true);
    expect(SCOPE.test("scopeLlmUsage(q, { isAdmin, memberId })")).toBe(true);
    expect(SCOPE.test('q.eq("team_id", t)')).toBe(false);
  });
});
