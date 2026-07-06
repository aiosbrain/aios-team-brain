import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the identity CONTEXT tables — `member_profiles`, `member_time_off`,
 * `member_goals` (CLAUDE.md §2). They are written ONLY by `lib/identity/profile.ts`, the path
 * that validates (tz / working-hours / channel allowlist / date sanity) and audits every change.
 * This test fails the build if any OTHER file inserts/updates/upserts/deletes them, so the
 * single-writer contract is structural rather than discipline. (Reads — select — are fine.)
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNER = join("lib", "identity", "profile.ts");
const TABLES = ["member_profiles", "member_time_off", "member_goals"] as const;
const writeRe = (table: string) =>
  new RegExp(`from\\(\\s*["']${table}["']\\s*\\)\\s*\\.\\s*(insert|update|upsert|delete)\\b`, "g");

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
      if (rel === OWNER) continue;
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      const src = readFileSync(file, "utf8");
      for (const table of TABLES) {
        for (const m of src.matchAll(writeRe(table))) hits.push(`${rel}: .from("${table}").${m[1]}(`);
      }
    }
  }
  return hits.sort();
}

describe("single-writer: identity context tables", () => {
  it("only lib/identity/profile.ts writes member_profiles / member_time_off / member_goals", () => {
    const violations = offenders();
    expect(
      violations,
      `identity-context tables written outside lib/identity/profile.ts (the audited single writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates writes from reads (non-vacuity)", () => {
    expect(writeRe("member_goals").test('db.from("member_goals").insert(')).toBe(true);
    expect(writeRe("member_profiles").test('admin.from("member_profiles").upsert(')).toBe(true);
    expect(writeRe("member_time_off").test('admin.from("member_time_off").delete(')).toBe(true);
    expect(writeRe("member_goals").test('db.from("member_goals").select(')).toBe(false);
  });
});
