import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Dashboard tier-isolation guard (CLAUDE.md §5). In postgres mode there is no RLS, so any
 * dashboard page that reads `items` MUST apply the viewer's tier filter in app code via the
 * `visibleItems()` choke-point (or single-item `canSeeAccess()`). This guard fails the build
 * if a page reads `items` without going through the choke-point — so the leak can't recur.
 * A genuinely tier-agnostic read may opt out with a `// tier-ok: <reason>` comment.
 */

const DASH_DIR = join(import.meta.dirname, "..", "..", "app", "t");
const CHOKE = /(visibleItems|canSeeAccess)\s*\(/;
const READS_ITEMS = /from\(\s*["']items["']\s*\)/;
const DECISION_CHOKE = /(visibleDecisions|canSeeAccess)\s*\(/;
const READS_DECISIONS = /from\(\s*["']decisions["']\s*\)/;
const OPT_OUT = /tier-ok:/;

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

function offendersFor(reads: RegExp, choke: RegExp): string[] {
  const hits: string[] = [];
  for (const file of walk(DASH_DIR)) {
    const src = readFileSync(file, "utf8");
    if (!reads.test(src)) continue;
    if (OPT_OUT.test(src)) continue;
    if (!choke.test(src)) hits.push(file.slice(file.indexOf("app/")));
  }
  return hits.sort();
}

const offenders = () => offendersFor(READS_ITEMS, CHOKE);

describe("dashboard tier isolation", () => {
  it("every dashboard page reading items applies the tier choke-point", () => {
    const violations = offenders();
    expect(
      violations,
      `Dashboard pages read items without the tier filter (no RLS backstop in postgres mode).\n` +
        `Route the read through visibleItems()/canSeeAccess() (or // tier-ok: <reason>):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("every dashboard page reading decisions applies the tier choke-point", () => {
    const violations = offendersFor(READS_DECISIONS, DECISION_CHOKE);
    expect(
      violations,
      `Dashboard pages read decisions without the audience tier filter (no RLS backstop).\n` +
        `Route the read through visibleDecisions() (or // tier-ok: <reason>):\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the matchers discriminate (non-vacuity)", () => {
    expect(READS_ITEMS.test('db.from("items").select("id")')).toBe(true);
    expect(READS_DECISIONS.test('db.from("decisions").select("id")')).toBe(true);
    expect(CHOKE.test("query = visibleItems(query, me.tier)")).toBe(true);
    expect(DECISION_CHOKE.test("visibleDecisions(q, tier)")).toBe(true);
    expect(CHOKE.test('q.eq("team_id", t)')).toBe(false);
  });
});
