import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the Social Brain content tables (CLAUDE.md §2): `social_opportunities`,
 * `content_plans`, `content_variants`, `content_images` are written ONLY by `lib/social/store.ts` —
 * the path that enforces tier inheritance (plan ⟵ opportunity, variant ⟵ plan, image ⟵ variant).
 * This fails the build if any other file writes them, so the tier-propagation invariant can't be
 * bypassed. (Reads are fine.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [join("lib", "social", "store.ts")];
const TABLES = "(social_opportunities|content_plans|content_variants|content_images)";
const WRITE_RE = new RegExp(
  `from\\(\\s*["']${TABLES}["']\\s*\\)\\s*\\.\\s*(insert|update|upsert|delete)\\b`,
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
      if (OWNERS.some((o) => rel === o)) continue;
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("${m[1]}").${m[2]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: social content tables", () => {
  it("only lib/social/store.ts writes opportunities/plans/variants", () => {
    const violations = offenders();
    expect(
      violations,
      `social content written outside lib/social/store.ts (the single writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('db.from("content_variants").insert(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("social_opportunities").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
