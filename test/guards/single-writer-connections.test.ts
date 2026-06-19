import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the `connections` table (Integrations settings). It holds the
 * encrypted connector secrets, so only `lib/connections` may write it — that module owns
 * encryption-on-write and the decrypt-on-read path. This fails the build if any other file
 * inserts/updates/upserts/deletes `connections`, so a future surface can't bypass the
 * encryption boundary. (Reads — `.select` — are fine.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "connections");
const WRITE_RE = /from\(\s*["']connections["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      if (rel.startsWith(OWNER)) continue;
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("connections").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: connections", () => {
  it("only lib/connections writes the connections table", () => {
    const violations = offenders();
    expect(
      violations,
      `connections written outside lib/connections (the encryption-owning writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    const W = () => new RegExp(WRITE_RE.source, "g");
    expect(W().test('supabase.from("connections").insert(rec)')).toBe(true);
    expect(W().test('supabase.from("connections").select("id")')).toBe(false);
  });
});
