import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-writer guards for the Social Brain M4 tables (CLAUDE.md §2): `social_settings` (autonomy,
 * written only by lib/social/settings.ts) and `content_approvals` (the queue, written only by
 * lib/social/approvals.ts). Fails the build if anything else writes them.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["app", "lib", "scripts"];

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

function offenders(table: string, owner: string): string[] {
  const re = new RegExp(`from\\(\\s*["']${table}["']\\s*\\)\\s*\\.\\s*(insert|update|upsert|delete)\\b`, "g");
  const hits: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(ROOT, d))) {
      const rel = file.slice(ROOT.length + 1);
      if (rel === owner) continue;
      if (rel.endsWith(".test.ts") || rel.includes("fake-supabase")) continue;
      for (const m of readFileSync(file, "utf8").matchAll(re)) hits.push(`${rel}: .from("${table}").${m[1]}(`);
    }
  }
  return hits.sort();
}

describe("single-writer: Social Brain approval tables", () => {
  it("only lib/social/settings.ts writes social_settings", () => {
    expect(offenders("social_settings", join("lib", "social", "settings.ts"))).toEqual([]);
  });
  it("only lib/social/approvals.ts writes content_approvals", () => {
    expect(offenders("content_approvals", join("lib", "social", "approvals.ts"))).toEqual([]);
  });
});
