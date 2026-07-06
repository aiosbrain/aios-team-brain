import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guard for the `member_secrets` table. It is written ONLY by
 * `lib/member-secrets/manage.ts` — the audited encrypt/decrypt path. Reads are
 * fine from the owner-authed route via that lib; this test fails if any other file
 * inserts/updates/upserts/deletes `member_secrets` directly.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];
const OWNERS = [join("lib", "member-secrets", "manage.ts")];
const WRITE_RE = /from\(\s*["']member_secrets["']\s*\)\s*\.\s*(insert|update|upsert|delete)\b/g;

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
      for (const m of src.matchAll(WRITE_RE)) hits.push(`${rel}: .from("member_secrets").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: member_secrets table", () => {
  it("only lib/member-secrets/manage.ts writes the member_secrets table", () => {
    const violations = offenders();
    expect(
      violations,
      `member_secrets written outside lib/member-secrets/manage.ts (the audited single writer):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(WRITE_RE.test('db.from("member_secrets").upsert(')).toBe(true);
    WRITE_RE.lastIndex = 0;
    expect(WRITE_RE.test('db.from("member_secrets").select(')).toBe(false);
    WRITE_RE.lastIndex = 0;
  });
});
