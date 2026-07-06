import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard (playbook §4 / skeleton C). `items` and `item_versions` are the
 * core knowledge store; the contract (README + CLAUDE.md §1) is that **only `lib/ingest`
 * writes them** — the one audited, dedup/version-aware write path. This test fails the
 * build if any other file performs an insert/update/upsert/delete on those tables, so the
 * contract is enforced by structure, not reviewer memory. (Reads — `.select` — are fine.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "ingest"); // the only legal writer lives here
// A write to items/item_versions: `.from("items").insert(` etc., possibly across a newline.
const WRITE_RE = /from\(\s*["'](items|item_versions)["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      if (rel.startsWith(OWNER)) continue; // the sanctioned writer
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(WRITE_RE)) {
        hits.push(`${rel}: .from("${m[1]}").${m[2]}(`);
      }
    }
  }
  return hits.sort();
}

describe("single-writer: items / item_versions", () => {
  it("only lib/ingest writes items/item_versions", () => {
    const violations = offenders();
    expect(
      violations,
      `Only lib/ingest may write items/item_versions (the audited write path). Offenders:\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    const W = () => new RegExp(WRITE_RE.source, "g");
    expect(W().test('await db.from("items").insert(rec)')).toBe(true);
    expect(W().test('await db.from("item_versions")\n  .update(x)')).toBe(true);
    // reads must NOT trip it
    expect(W().test('db.from("items").select("id").eq("team_id", t)')).toBe(false);
    // a different table must NOT trip it
    expect(W().test('db.from("tasks").upsert(row)')).toBe(false);
  });
});
