import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the `media_assets` table (CLAUDE.md §2). Written ONLY by
 * `lib/media/store.ts` (validated + audited). Fails the build if any other file writes it.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [join("lib", "media", "store.ts")];
const WRITE_RE = /from\(\s*["']media_assets["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("media_assets").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: media_assets table", () => {
  it("only lib/media/store.ts writes the media_assets table", () => {
    const violations = offenders();
    expect(violations, `media_assets written outside lib/media/store.ts:\n${violations.join("\n")}`).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('db.from("media_assets").insert(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("media_assets").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
