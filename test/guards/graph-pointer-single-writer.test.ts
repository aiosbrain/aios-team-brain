import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * `projects.graph_group_id` single-writer guard (PCCC-4; CLAUDE.md §2 principle 2). The pointer
 * IS the graph partition map — enforcing reads (PCCC-6) resolve it instead of recomputing, and
 * the §11 built-ins carry grandfathered legacy ids a recompute would get wrong. Its invariants
 * (immutability, the one sanctioned adoption rewrite, grandfather-vs-mint) are real only while
 * lib/graph/project-pointer.ts is the ONLY module that writes the column (the 20260815140000
 * backfill migration being SQL, outside this scan's domain).
 *
 * The check flags `graph_group_id` appearing INSIDE a write call's payload
 * (`.insert(…)/.upsert(…)/.update(…)`) anywhere outside the writer. A payload assembled in a
 * separate variable would evade it — flagged as a known limit, same as the sibling guards.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const SINGLE_WRITER = join("lib", "graph", "project-pointer.ts");
const WRITE_WITH_POINTER = /\.\s*(insert|upsert|update)\s*\(\s*\{[^)]*graph_group_id/s;
/** Raw-SQL evasion: `runSql("update projects set graph_group_id …")` never matches the builder
 *  pattern. (Known remaining limit: a payload assembled in a separate variable, or a value
 *  containing `)` before the key — same class as the sibling guards.) */
const RAW_SQL_POINTER_WRITE = /set\s+graph_group_id/i;
/**
 * The inverse check (review Medium 3a — the pin-the-call-site class): forbidding writes elsewhere
 * cannot prove a creation path CALLS the writer. Deleting the dashboard action's call left every
 * test green; this list makes each wired site load-bearing.
 */
const REQUIRED_CALL_SITES: { file: string; minCalls: number }[] = [
  { file: join("lib", "access", "bootstrap.ts"), minCalls: 2 }, // fresh insert + adoption/convergence
  { file: join("app", "actions", "projects.ts"), minCalls: 2 }, // success path + duplicate-branch heal (Codex M3: a substring check let either one vanish)
  { file: join("lib", "ingest", "index.ts"), minCalls: 1 },
  { file: join("lib", "meetings", "extract-todos.ts"), minCalls: 1 },
];

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
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

describe("projects.graph_group_id single-writer", () => {
  it("no module outside lib/graph/project-pointer.ts writes the pointer column", () => {
    const offenders: string[] = [];
    for (const dir of SCAN_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        const rel = relative(ROOT, file);
        if (rel === SINGLE_WRITER) continue;
        const src = readFileSync(file, "utf8");
        if (WRITE_WITH_POINTER.test(src) || RAW_SQL_POINTER_WRITE.test(src)) offenders.push(rel);
      }
    }
    expect(offenders, `graph_group_id written outside the single writer: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the guard is non-vacuous: the single writer itself matches the pattern", () => {
    const src = readFileSync(join(ROOT, SINGLE_WRITER), "utf8");
    expect(WRITE_WITH_POINTER.test(src)).toBe(true);
  });

  it("every creation path CALLS the writer — forbidding writes elsewhere cannot prove the wiring exists", () => {
    for (const { file, minCalls } of REQUIRED_CALL_SITES) {
      const src = readFileSync(join(ROOT, file), "utf8");
      const calls = (src.match(/ensureProjectGraphPointer\(/g) ?? []).length;
      expect(calls, `${file}: ${calls} ensureProjectGraphPointer call(s), needs ≥ ${minCalls}`).toBeGreaterThanOrEqual(
        minCalls
      );
    }
  });
});
