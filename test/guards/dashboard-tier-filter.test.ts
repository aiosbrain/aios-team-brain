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

/**
 * ENFB-1 §2.3 — the ORACLE layer: the posture choke-point above is the COARSE wall only; every
 * BODY-SERVING surface must ALSO call the membership oracle (canSeeItem / visibleItemIds /
 * rowVisibleByProvenance). The set is ENUMERATED (not pattern-derived) because body-serving is
 * a property of what a page renders, which no regex over its reads can see. Known ENFB-2
 * residuals (title/metadata surfaces incl. the ungated projects LIST inventory — invisible to
 * the READS_ITEMS regex because `items(count)` embeds don't match it) are deliberately NOT
 * here; they are the next slice's rows, recorded so their absence reads as a decision.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const ORACLE = /(canSeeItem|visibleItemIds|rowVisibleByProvenance)\s*\(/;
const BODY_SURFACES = [
  "app/t/[team]/library/[itemId]/page.tsx",
  "app/t/[team]/library/skills/page.tsx",
  "app/t/[team]/team-tools/page.tsx",
  "app/t/[team]/tasks/page.tsx",
  "app/t/[team]/decisions/page.tsx",
  "components/library/data-browser.tsx",
  "app/api/v1/items/[id]/route.ts",
  "app/api/v1/okf-bundle/route.ts",
];

describe("ENFB-1 — body-serving surfaces call the membership oracle (the coarse wall is not sufficiency)", () => {
  it("every body surface references an oracle primitive", () => {
    const missing = BODY_SURFACES.filter((f) => !ORACLE.test(readFileSync(join(ROOT, f), "utf8")));
    expect(
      missing,
      `Body-serving surfaces without a membership-oracle call (the posture helpers alone are the\n` +
        `pre-ENFB-1 coarse wall — a restricted initiative's bodies would serve to every team member):\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("the oracle matcher discriminates (non-vacuity)", () => {
    expect(ORACLE.test("await canSeeItem(db, principal, id)")).toBe(true);
    expect(ORACLE.test("const vis = await visibleItemIds(db, p)")).toBe(true);
    expect(ORACLE.test("rows.filter((r) => rowVisibleByProvenance(r, ids, tier))")).toBe(true);
    expect(ORACLE.test("visibleItems(q, tier)")).toBe(false);
    expect(ORACLE.test("canSeeAccess(tier, access)")).toBe(false);
  });
});
