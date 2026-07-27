import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Bounded-writer guard for the `task_evidence` table (CLAUDE.md §2) — the persisted task↔evidence edges.
 * TWO writers are legal, and they are safe ONLY because each prunes exclusively its own `method`:
 *
 *   • `lib/dashboard/timeline-evidence.ts`  → `method='issue_ref'` (deterministic issue-key links)
 *   • `lib/dashboard/doc-task-infer-run.ts` → `method='llm'`       (the LLM doc→task assignment)
 *
 * A third writer, or either of these widening its delete beyond its own method, would silently wipe the
 * other's edges on the next scheduler tick — and since the timeline now READS this table, that shows up
 * as work disappearing from people's days rather than as an error. Build-failing so it can't drift.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [
  join("lib", "dashboard", "timeline-evidence.ts"),
  join("lib", "dashboard", "doc-task-infer-run.ts"),
];
const WRITE_RE = /from\(\s*["']task_evidence["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("task_evidence").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("bounded-writer: task_evidence table", () => {
  it("only the two owning modules write task_evidence", () => {
    const violations = offenders();
    expect(violations, `task_evidence written outside its two owners:\n${violations.join("\n")}`).toEqual([]);
  });

  it("each writer's DELETE is scoped to its OWN method — the whole reason two writers are safe", () => {
    for (const [owner, method] of [
      [join("lib", "dashboard", "timeline-evidence.ts"), "issue_ref"],
      [join("lib", "dashboard", "doc-task-infer-run.ts"), "llm"],
    ] as const) {
      const src = readFileSync(join(ROOT, owner), "utf8");
      // Every delete against the table in this file must carry its own method filter on the same call.
      const deletes = [...src.matchAll(/from\(\s*["']task_evidence["']\s*\)([\s\S]{0,200}?);/g)]
        .map((m) => m[0])
        .filter((call) => /\.delete\(/.test(call));
      expect(deletes.length, `${owner} should prune its own edges`).toBeGreaterThan(0);
      for (const call of deletes) {
        expect(call, `${owner} deletes task_evidence without scoping to method='${method}'`).toContain(`"${method}"`);
      }
    }
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('db.from("task_evidence").insert(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("task_evidence").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
