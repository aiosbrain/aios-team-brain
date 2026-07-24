import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the `llm_usage` table (CLAUDE.md §2) — the brain-inference spend ledger
 * that feeds the Pulse Spend KPI + the Costs breakdown page. Written ONLY by `lib/costs/llm-usage.ts`
 * (`recordLlmUsage`). If any other file inserts/updates it, spend metering forks and the totals drift
 * — this fails the build so every LLM caller records through the one primitive.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [join("lib", "costs", "llm-usage.ts")];
const WRITE_RE = /from\(\s*["']llm_usage["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("llm_usage").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: llm_usage table", () => {
  it("only lib/costs/llm-usage.ts writes the llm_usage table", () => {
    const violations = offenders();
    expect(violations, `llm_usage written outside lib/costs/llm-usage.ts:\n${violations.join("\n")}`).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('db.from("llm_usage").insert(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("llm_usage").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
