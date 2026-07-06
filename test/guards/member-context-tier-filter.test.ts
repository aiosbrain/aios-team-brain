import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Identity-context tier-isolation guard (CLAUDE.md §5). Per-member context (working hours,
 * OKRs, time off) is team-tier only and there is NO RLS in postgres mode, so the app-code gate
 * is the sole enforcement. This guard enforces two structural facts:
 *   (a) dashboard PAGES never read the context tables directly — they go through
 *       lib/identity/context (so the gate can't be skipped per-page);
 *   (b) the read helper itself applies the `canSeeMemberContext(tier)` gate.
 * The real proof is the data-mechanics isolation test; this fails fast in review.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const PAGES_DIR = join(ROOT, "app", "t");
const HELPER = join(ROOT, "lib", "identity", "context.ts");
const TABLES = /from\(\s*["'](member_profiles|member_time_off|member_goals)["']\s*\)/;

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
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("identity-context tier isolation", () => {
  it("dashboard pages never read context tables directly (only via lib/identity/context)", () => {
    const offenders = walk(PAGES_DIR)
      .filter((f) => TABLES.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(f.indexOf("app/")));
    expect(
      offenders,
      `Pages read identity-context tables directly (no tier gate / no RLS backstop). ` +
        `Route reads through lib/identity/context:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the read helper applies the canSeeMemberContext tier gate", () => {
    const src = readFileSync(HELPER, "utf8");
    expect(src).toMatch(/canSeeMemberContext\s*\(/);
  });

  it("getMemberContext gates before reading any context table", () => {
    const src = readFileSync(HELPER, "utf8");
    const body = src.split("export async function getMemberContext")[1] ?? "";
    const gateAt = body.indexOf("canSeeMemberContext");
    const firstRead = body.search(/from\(\s*["'](member_profiles|member_time_off|member_goals)["']\s*\)/);
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(firstRead === -1 || gateAt < firstRead).toBe(true);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(TABLES.test('db.from("member_goals").select("x")')).toBe(true);
    expect(TABLES.test('db.from("members").select("x")')).toBe(false);
  });
});
