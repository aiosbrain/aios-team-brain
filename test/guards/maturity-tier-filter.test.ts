import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Agentic-maturity tier-isolation guard (CLAUDE.md §5). Maturity analytics are
 * team-tier only and there is NO RLS in postgres mode, so the app-code gate is the
 * sole enforcement. The dashboard guard only watches `items`, so maturity reads
 * need their own. This guard enforces:
 *   (a) maturity dashboard PAGES never read the snapshots table directly — they go
 *       through lib/metrics/maturity (so the gate can't be skipped per-page);
 *   (b) every exported reader there applies the `canSeeMaturity(tier)` gate.
 * The real proof is the data-mechanics isolation test; this fails fast in review.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const PAGES_DIR = join(ROOT, "app", "t");
const HELPER = join(ROOT, "lib", "metrics", "individual-maturity.ts");
const TABLE = /from\(\s*["']agentic_maturity_snapshots["']\s*\)/;

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

describe("agentic-maturity tier isolation", () => {
  it("dashboard pages never read the snapshots table directly (only via lib/metrics/maturity)", () => {
    const offenders = walk(PAGES_DIR)
      .filter((f) => TABLE.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(f.indexOf("app/")));
    expect(
      offenders,
      `Pages read agentic_maturity_snapshots directly (no tier gate / no RLS backstop):\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the read helper applies the canSeeMaturity tier gate", () => {
    expect(readFileSync(HELPER, "utf8")).toMatch(/canSeeMaturity\s*\(/);
  });

  it("EVERY exported helper that reads the snapshots table gates on canSeeMaturity", () => {
    const src = readFileSync(HELPER, "utf8");
    const ungated = src
      .split(/export async function /)
      .slice(1)
      .filter((chunk) => TABLE.test(chunk) && !/canSeeMaturity\s*\(/.test(chunk))
      .map((chunk) => chunk.slice(0, chunk.indexOf("(")));
    expect(
      ungated,
      `helper fn(s) read the snapshots table without a canSeeMaturity gate: ${ungated.join(", ")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(TABLE.test('supabase.from("agentic_maturity_snapshots").select("x")')).toBe(true);
    expect(TABLE.test('supabase.from("items").select("x")')).toBe(false);
  });
});
