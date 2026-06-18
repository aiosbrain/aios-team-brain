import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * query_log row-scoping guard (CLAUDE.md §5). In postgres mode there is no RLS, so any read of
 * `query_log` that renders to a viewer MUST scope rows in app code via `scopeQueryLog` — members
 * see only their own questions/cost, admins see the team. This guard fails the build if a
 * dashboard page or metrics module reads `query_log` without it, so the prior leak (a page that
 * read the whole team's query_log behind a false "RLS handles it" comment) can't recur.
 * A genuinely viewer-agnostic read (e.g. a cron aggregate) may opt out with `// query-scope-ok: <reason>`.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = [join(ROOT, "app", "t"), join(ROOT, "lib", "metrics")];
const SCOPE = /scopeQueryLog\s*\(/;
const READS_QUERY_LOG = /from\(\s*["']query_log["']\s*\)/;
const OPT_OUT = /query-scope-ok:/;

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
      if (!READS_QUERY_LOG.test(src)) continue;
      if (OPT_OUT.test(src)) continue;
      if (!SCOPE.test(src)) hits.push(file.slice(file.indexOf("aios-team-brain/") + "aios-team-brain/".length));
    }
  }
  return hits.sort();
}

describe("query_log row-level visibility", () => {
  it("every dashboard/metrics read of query_log scopes rows by member/role", () => {
    const violations = offenders();
    expect(
      violations,
      `Reads of query_log without scopeQueryLog (no RLS backstop in postgres mode):\n` +
        `Route the read through scopeQueryLog() (or // query-scope-ok: <reason>):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matchers discriminate (non-vacuity)", () => {
    expect(READS_QUERY_LOG.test('supabase.from("query_log").select("cost_usd")')).toBe(true);
    expect(SCOPE.test("scopeQueryLog(q, { isAdmin, memberId })")).toBe(true);
    expect(SCOPE.test('q.eq("team_id", t)')).toBe(false);
  });
});
