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
/** Per-file APPLICATION patterns (diff-review Medium: presence of a resolution without its
 *  APPLICATION site survived every layer — a page could resolve the vis set and never filter
 *  with it). Each pattern matches the point where the oracle result GATES rows. */
const BODY_SURFACE_WIRING: [string, RegExp][] = [
  ["app/t/[team]/library/[itemId]/page.tsx", /await canSeeItem\(.*\)\s*notFound\(\)/],
  ["app/t/[team]/library/skills/page.tsx", /\.in\("id", \[\.\.\.vis\.ids\]\)/],
  ["app/t/[team]/team-tools/page.tsx", /\.in\("id", \[\.\.\.vis\.ids\]\)/],
  ["app/t/[team]/tasks/page.tsx", /\.filter\(\(t\) => rowVisibleByProvenance\(/],
  ["app/t/[team]/decisions/page.tsx", /\.filter\(\(d\) => rowVisibleByProvenance\(/],
  ["components/library/data-browser.tsx", /\.in\("id", visArr\)/],
  ["app/api/v1/items/[id]/route.ts", /await canSeeItem\(/],
  ["app/api/v1/okf-bundle/route.ts", /pageVisibleOkfItems\(/],
];

describe("ENFB-1 — body-serving surfaces APPLY the membership oracle (the coarse wall is not sufficiency)", () => {
  it("every body surface's oracle APPLICATION site is present", () => {
    const missing = BODY_SURFACE_WIRING.filter(([f, pat]) => !pat.test(readFileSync(join(ROOT, f), "utf8"))).map(([f]) => f);
    expect(
      missing,
      `Body-serving surfaces whose oracle APPLICATION site is gone (resolving the set without\n` +
        `applying it is the pre-ENFB-1 coarse wall in disguise):\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("the wiring matchers discriminate (non-vacuity: each pattern is an application, not a resolution)", () => {
    const tasksPat = BODY_SURFACE_WIRING.find(([f]) => f.includes("tasks/page"))![1];
    expect(tasksPat.test('rows.filter((t) => rowVisibleByProvenance(t, ids, tier))')).toBe(true);
    expect(tasksPat.test('const vis = await visibleItemIds(db, p)'), "a bare resolution must NOT satisfy the wiring pin").toBe(false);
    const skillsPat = BODY_SURFACE_WIRING.find(([f]) => f.includes("skills"))![1];
    expect(skillsPat.test('.in("id", [...vis.ids])')).toBe(true);
    expect(skillsPat.test('visibleItems(q, tier)')).toBe(false);
  });
});
