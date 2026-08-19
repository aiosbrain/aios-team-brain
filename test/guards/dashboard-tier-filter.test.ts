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
 * a property of what a page renders, which no regex over its reads can see.
 * ENFB-2 moved the recorded title/metadata residuals (the projects LIST inventory, the tasks
 * API, the decisions feed, Pulse counts, deriveProjects) from "recorded" to ENFORCED — see
 * TITLE_SURFACE_WIRING + the sweep layer below. ENFB-3 enforced meetings (the item oracle via
 * source_item_id, which was never blocked on schema) and moved the graph feeds to the
 * stored-pointer partition path. ENFB-4 enforced social — the enforcement backlog's LAST
 * residual (SOCIAL_SURFACE_WIRING below): the EVERY read rule at the opportunity, chain
 * inheritance downstream, actor-scoped admission, the action-level chain gates, generation's
 * EVERY refusal, and the publish door's external-shared membership conjunct. The backlog's
 * residual list is now EMPTY; what stays ungated is stated per-file in SWEEP_RESIDUALS
 * (ops/config and counts-only surfaces — the role/metrics rulings).
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
  // ENFB-2 (Codex diff H2): the member-driven meeting-todo scan serves item BODIES back to
  // the caller — the action passes the caller's oracle set, and the helper applies it
  // in-query. Both halves pinned (resolution without application is the pre-ENFB-1 wall).
  ["app/actions/meeting-todos.ts", /visibleItemIds: \[\.\.\.vis\.ids\]/],
  ["lib/meetings/extract-todos.ts", /q\.in\("id", \[\.\.\.opts\.visibleItemIds\]\)/],
  // ENFB-3: the meetings serving reads — the list's in-query intersect and the detail's
  // by-id probe (the detail serves the transcript BODY, the same bytes the library page
  // gates). Tombstone refusal rides the same detail pin.
  ["lib/meetings/notes.ts", /\.in\("source_item_id", \[\.\.\.vis\.ids\]\)/],
  ["lib/meetings/notes.ts", /await canSeeItem\(db, \{ teamId, memberId: viewer\.memberId \}, row\.source_item_id\)/],
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

/**
 * ENFB-2 §2.8 — the TITLE/COUNT layer. Two parts:
 *
 * 1. TITLE_SURFACE_WIRING — per-file APPLICATION patterns (the ENFB-1 discipline from birth):
 *    each pattern matches the point where the oracle/predicate GATES rows, not where a set is
 *    merely resolved.
 * 2. The SWEEP — a TRIPWIRE, not a closure proof (design round 2 M8): every file under
 *    app/api/**\/route.ts + lib/{sync,metrics,identity,dashboard,social} that reads
 *    projects/tasks/decisions with a name/title/count-bearing select must be either in the
 *    wiring sets or on the STATED-RESIDUAL list (each entry with its reason). A new ungated
 *    list surface tomorrow reddens the build instead of riding the projects-list gap.
 *    Named non-coverage: select("*"), template-built column lists, raw SQL string reads, and
 *    variable table names pass this regex — the enumerated APPLICATION patterns and the
 *    review gate remain the net for those shapes.
 */
const TITLE_SURFACE_WIRING: [string, RegExp][] = [
  ["app/t/[team]/projects/page.tsx", /visibleProjectCards\(/],
  ["app/t/[team]/projects/[project]/page.tsx", /await canSeeProjectRow\([\s\S]*?notFound\(\)/],
  ["app/t/[team]/tasks/page.tsx", /boardTaskWindow[<(]/],
  ["app/t/[team]/tasks/page.tsx", /\.in\("id", projRows && !projRows\.error \? \[\.\.\.projRows\.ids\] : \[\]\)/],
  ["app/t/[team]/decisions/page.tsx", /\.in\("id", projRows && !projRows\.error \? \[\.\.\.projRows\.ids\] : \[\]\)/],
  // The dropdown RESOLUTION pins (Fable diff M4: the .in patterns alone matched any set with
  // an `.ids` — substituting the GRANTED set for the row-visible set shipped green; these pin
  // the §2.1 resolution the round-2 BLOCKER-1 conflation would replace).
  ["app/t/[team]/tasks/page.tsx", /await visibleProjectRows\(adminClient\(\)/],
  ["app/t/[team]/decisions/page.tsx", /await visibleProjectRows\(adminClient\(\)/],
  // The adjacent WRITE routes (Fable diff HIGH 2): filing a hand-typed row into a container
  // un-hides it (§2.1 content arms), so both create actions gate on the same row visibility.
  ["app/actions/tasks.ts", /await canSeeProjectRow\(adminClient\(\)/],
  ["app/actions/decisions.ts", /await canSeeProjectRow\(adminClient\(\)/],
  ["app/t/[team]/page.tsx", /decisionsCardWindow\(team\.id, provCtx/],
  ["app/t/[team]/library/[itemId]/page.tsx", /await canSeeProjectRow\(/],
  ["app/api/v1/projects/route.ts", /\.in\("id", \[\.\.\.rows\.ids\]\)/],
  ["app/api/v1/tasks/route.ts", /taskFeedWindow\(/],
  // The windows module: each window's OWN predicate application (per-function pins — deleting
  // the fragment from one window must redden even while a sibling still carries it).
  ["lib/access/structured-windows.ts", /boardTaskWindow[\s\S]{0,900}?provenanceRowSqlFromIds\("t", p, ctx\)/],
  ["lib/access/structured-windows.ts", /decisionsCardWindow[\s\S]{0,900}?provenanceRowSqlFromIds\("d", p, ctx\)/],
  ["lib/access/structured-windows.ts", /taskFeedWindow[\s\S]{0,1600}?provenanceRowSqlFromIds\("t", p, ctx\)/],
  ["lib/sync/decisions.ts", /provenanceRowSqlFromIds\("d", p, enforce\)/],
  ["lib/metrics/pulse.ts", /provenanceRowSqlFromIds\("t", p, provCtx\)/],
  ["lib/metrics/pulse.ts", /\.in\("id", \[\.\.\.provCtx\.visibleItemIds\]\)/],
  ["lib/identity/context.ts", /provenanceRowSqlFromIds\("t", p, viewerCtx\)/],
  ["lib/query/retrieve.ts", /provenanceRowSqlFromIds\("d", dParams, provCtx\)/],
  ["lib/query/retrieve.ts", /provenanceRowSqlFromIds\("t", tParams, provCtx\)/],
  ["lib/query/structured-extras.ts", /provenanceRowSqlFromIds\("d", p, \{/],
  ["lib/dashboard/work-timeline.ts", /provenanceRowSqlFromIds\("t", p, provCtx\)/],
  ["lib/dashboard/work-timeline.ts", /provenanceRowSqlFromIds\("d", p, provCtx\)/],
];

/**
 * ENFB-4 — the SOCIAL layer (spec §1/§2): the chain gates on the membership oracle at
 * admission, read, action, generation, and the public door. Each pattern pins an APPLICATION
 * site (where the oracle result gates rows or refuses), never a bare resolution — and each
 * layer's DISTINCT property is pinned separately so deleting one layer reddens even while a
 * sibling still catches the outcome.
 */
const SOCIAL_SURFACE_WIRING: [string, RegExp][] = [
  // The ONE read rule (D1b): fail-closed without a viewer set + the EVERY intersection applied.
  ["lib/social/store.ts", /if \(!viewerVisibleItemIds\) return \[\];/],
  ["lib/social/store.ts", /\.filter\(\(o\) => opportunityVisible\(o, viewerVisibleItemIds\)\)/],
  // The named predicate itself — the EVERY quantifier over evidence (itemId required per entry).
  ["lib/social/store.ts", /opp\.evidence\.length > 0 && opp\.evidence\.every\(\(e\) => !!e\.itemId && vis\.has\(e\.itemId\)\)/],
  // Admission (D1): evidence-less opportunities are unmintable; empty/partial arcs refuse.
  ["lib/social/store.ts", /if \(!input\.evidence \|\| input\.evidence\.length === 0\)/],
  ["lib/social/discover-arcs.ts", /evidence\.length === 0 \|\| evidence\.length < arc\.evidence\.length/],
  // Admission (D2a): the items scan is bounded to the acting admin's oracle set, fail closed.
  ["lib/social/discover.ts", /if \(!opts\.visibleItemIds\) return \{ scanned: 0/],
  ["lib/social/discover.ts", /\.in\("id", \[\.\.\.opts\.visibleItemIds\]\)/],
  // The page routes through the store (viewer set at the list; chain inheritance below it).
  ["app/t/[team]/social/page.tsx", /listOpportunities\(db, team\.id, "team", 100, vis\.ids\)/],
  ["app/t/[team]/social/page.tsx", /listPlansForOpportunities\(db, team\.id, visibleOppIds\)/],
  // The variant-child reads inherit IN-QUERY (Codex diff fold: a post-limit filter let hidden
  // rows starve visible history out of the capped window) — page application + module gate.
  ["app/t/[team]/social/page.tsx", /listPublications\(db, team\.id, 200, visibleVariantIds\)/],
  ["lib/social/publications.ts", /\.in\("variant_id", \[\.\.\.variantIds\]\)/],
  ["lib/social/approvals.ts", /\.in\("variant_id", \[\.\.\.variantIds\]\)/],
  ["lib/media/store.ts", /\.in\("variant_id", \[\.\.\.variantIds\]\)/],
  // The action-level parent gate (round 1 H4): ONE resolver, hidden parent = not found.
  ["app/t/[team]/social/actions.ts", /await actorSeesChain\(adminClient\(\), teamId, ref, vis\.ids\)/],
  // Generation's EVERY refusal (D4): no silent degradation, no prompt over hidden sources.
  ["lib/social/generate.ts", /if \(!opportunityVisible\(opp, opts\.actorVisibleItemIds\)\)/],
  // The PUBLIC door's membership conjunct (round 1 BLOCKER 1): current external-shared include
  // for EVERY evidence item — via visibleItemIdsForProjects, NOT systemVisibleSourceIds.
  ["lib/social/publish.ts", /visibleItemIdsForProjects\(db, teamId, new Set\(\[\(extShared as \{ id: string \}\)\.id\]\)\)/],
  // The media route (D3): admin POSTURE + the asset's chain inherited to EVERY-visible evidence.
  ["app/api/dashboard/social/media/[id]/route.ts", /!canAccessAdmin\(member\)\) return notFound\(\)/],
  ["app/api/dashboard/social/media/[id]/route.ts", /await actorSeesChain\(adminClient\(\), teamId, \{ variantId:/],
];

/** Files the sweep may match WITHOUT a wiring row — each with its reason. An entry here is a
 *  DECISION on record, not an exemption by silence. */
const SWEEP_RESIDUALS: [string, string][] = [
  // ENFB-4 per-file residuals (spec §0b deferrals — the ops→role and counts→metrics rulings):
  ["lib/social/plan.ts", "resolves its parent by id beneath the ACTION gate (actorSeesChain in actions.ts); writes the plan chain, serves no list"],
  ["lib/social/analytics.ts", "counts only, no title/body — the metrics ruling (spec §0b)"],
  ["lib/social/collect-analytics.ts", "counts collector (scheduler-driven), no title/body — the metrics ruling"],
  ["lib/social/settings.ts", "team config/ops, no content axis — the ops→role arm (spec §0b)"],
  ["lib/social/autonomy.ts", "approval-policy config, no content axis — the ops→role arm"],
  ["lib/social/jobs-health.ts", "job counters, no content axis — the ops→role arm"],
  ["app/t/[team]/meetings/", "ENFB-3 ENFORCED the meetings gate (the old residual reason — 'no audience column' — was wrong: source_item_id NOT NULL makes the item oracle directly applicable). The actions ride the gated getMeetingNote; their task reads stay id-bounded PM-projection plumbing"],
  ["lib/meetings/notes.ts", "the serving reads ARE the gate (wired above in BODY_SURFACE_WIRING); the write/merge/backfill helpers are scheduler-driven, not serving reads"],
  ["lib/meetings/merge.ts", "scheduler-driven dedupe/merge — not a serving read; its item writes reconcile before re-point (ENFB-3 D2)"],
  ["lib/meetings/link-notes.ts", "scheduler/ingest-side identity link — not a serving read"],
  ["lib/meetings/refresh.ts", "operator healing pass — not a serving read"],
  ["lib/meetings/from-items.ts", "the backfill writer (admin-gated at its action, scheduler otherwise) — not a serving read"],
  ["lib/meetings/extract-todos.ts", "the scan is oracle-bounded (wired above); the task writers are the materialization path"],
  ["lib/dashboard/home-state.ts", "consumes the deliberate team-total scalar only (ENFB-2 F5)"],
  ["lib/metrics/codebases.ts", "code-metrics, not curated content — structure ruling (spec §0b)"],
  ["lib/metrics/maturity", "session-derived, not curated content — structure ruling (spec §0b)"],
  ["lib/sync/tasks", "projector write path, not a read surface"],
  ["lib/dashboard/team-work.ts", "consumes the enforced timeline builder's rows, no own read"],
  ["lib/dashboard/timeline-evidence.ts", "evidence rows ride the enforced timeline build (item legs in-query via withVis)"],
  ["lib/dashboard/doc-task-infer-run.ts", "ingest-side inference job, not a serving read surface"],
  ["lib/dashboard/timeline-cache.ts", "cache plumbing keyed per visibility variant; rows come from the enforced builder"],
  ["app/api/v1/okf-bundle/route.ts", "body surface — enforced + pinned in BODY_SURFACE_WIRING"],
  ["app/api/v1/items/", "body surface — enforced + pinned in BODY_SURFACE_WIRING"],
  ["app/api/v1/graph-query/route.ts", "stored-pointer partition scope (ENFB-1), no structured-row read"],
  ["app/api/brain/events/route.ts", "ENFB-3: oracle partitions via selectEnforcedGraphPartitions (pinned by graph-group-slug-derivation + graph-cutover-callsites); no structured-row read"],
  ["app/api/brain/facts/route.ts", "ENFB-3: same as events — the partition path is the gate"],
];

// app/t joined the walk at the Fable diff review (M5): the motivating bug — the ungated
// projects LIST — lived exactly there, and a sweep that skips the class's original habitat
// is a tripwire with a hole where the trap sprang.
const SWEEP_DIRS = ["app/api", "app/t", "lib/sync", "lib/metrics", "lib/identity", "lib/dashboard", "lib/social", "lib/meetings"];
const SWEEP_READ = /from\(\s*["'](projects|tasks|decisions|meeting_notes|social_opportunities|content_plans|content_variants)["']\s*\)/;
// ENFB-4 (Fable diff review M2): `body|summary` joined the serves-conjunct — variant BODIES are
// the crown-jewel column of the social slice, and a sweep that only recognizes title-shaped
// columns had a hole exactly that shape (a future `select("id, body")` on a content table would
// have slipped past the tripwire).
const SWEEP_SERVES = /select\(\s*["'][^"']*\b(name|title|count|slug|body|summary)\b[^"']*["']/;

describe("ENFB-2 — title/count surfaces APPLY the oracle (wiring + sweep tripwire)", () => {
  it("every title surface's application site is present", () => {
    const missing = TITLE_SURFACE_WIRING.filter(([f, pat]) => !pat.test(readFileSync(join(ROOT, f), "utf8"))).map(([f, pat]) => `${f} :: ${pat}`);
    expect(
      missing,
      `Title/count surfaces whose oracle/predicate APPLICATION site is gone:\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("sweep: no projects/tasks/decisions title-read outside the wiring + stated residuals", () => {
    const wired = new Set(TITLE_SURFACE_WIRING.map(([f]) => f));
    const bodyWired = new Set([...BODY_SURFACE_WIRING, ...SOCIAL_SURFACE_WIRING].map(([f]) => f));
    const offenders: string[] = [];
    for (const dir of SWEEP_DIRS) {
      for (const file of walk(join(ROOT, dir))) {
        if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
        if (/\.test\.tsx?$/.test(file)) continue;
        if (dir === "app/api" && !file.endsWith("route.ts")) continue;
        const rel = file.slice(file.indexOf(dir));
        const src = readFileSync(file, "utf8");
        if (!SWEEP_READ.test(src) || !SWEEP_SERVES.test(src)) continue;
        if (wired.has(rel) || bodyWired.has(rel)) continue;
        if (SWEEP_RESIDUALS.some(([prefix]) => rel.startsWith(prefix))) continue;
        offenders.push(rel);
      }
    }
    expect(
      offenders.sort(),
      `Files reading projects/tasks/decisions titles/names/counts that are neither WIRED nor on\n` +
        `the stated-residual list. Gate the read (visibleProjectRows / provenanceRowSqlFromIds /\n` +
        `rowVisibleByProvenance) and add the wiring row, or record the residual WITH its reason:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the sweep matchers discriminate (non-vacuity)", () => {
    expect(SWEEP_READ.test('db.from("projects").select("id, slug, name")')).toBe(true);
    expect(SWEEP_SERVES.test('.select("id, slug, name, last_synced_at")')).toBe(true);
    expect(SWEEP_READ.test('db.from("items").select("id")'), "items reads belong to the posture/body layers").toBe(false);
    expect(SWEEP_SERVES.test('.select("id, status")'), "an id/status-only select serves no title").toBe(false);
    expect(SWEEP_READ.test('db.from("social_opportunities").select("id, title")'), "ENFB-4: the social content tables are swept").toBe(true);
    expect(SWEEP_SERVES.test('.select("id, plan_id, body")'), "ENFB-4 M2: a body-serving select trips the sweep").toBe(true);
    expect(SWEEP_SERVES.test('.select("id, embedding")'), "substring must not false-positive (no bare-word match)").toBe(false);
    const projPat = TITLE_SURFACE_WIRING.find(([f]) => f === "app/t/[team]/projects/page.tsx")![1];
    expect(projPat.test("const cards = await visibleProjectCards(db, principal)")).toBe(true);
    expect(projPat.test("const rows = await visibleProjectRows(db, principal)"), "the list page must use the CARD read (visible counts), not the bare row set").toBe(false);
  });
});

describe("ENFB-4 — the social chain APPLIES the membership oracle (admission/read/action/generation/door)", () => {
  it("every social surface's application site is present", () => {
    const missing = SOCIAL_SURFACE_WIRING.filter(([f, pat]) => !pat.test(readFileSync(join(ROOT, f), "utf8"))).map(([f, pat]) => `${f} :: ${pat}`);
    expect(
      missing,
      `Social surfaces whose oracle/refusal APPLICATION site is gone (a resolution without its\n` +
        `application is the pre-ENFB-1 coarse wall in disguise):\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("the social wiring matchers discriminate (non-vacuity: application, not resolution)", () => {
    const listPat = SOCIAL_SURFACE_WIRING.find(([f, p]) => f.endsWith("store.ts") && String(p).includes("filter"))![1];
    expect(listPat.test(".filter((o) => opportunityVisible(o, viewerVisibleItemIds));")).toBe(true);
    expect(listPat.test("const vis = await visibleItemIds(db, p)"), "a bare resolution must NOT satisfy the read pin").toBe(false);
    const doorPat = SOCIAL_SURFACE_WIRING.find(([f]) => f.endsWith("publish.ts"))![1];
    expect(doorPat.test('await visibleItemIdsForProjects(db, teamId, new Set([(extShared as { id: string }).id]))')).toBe(true);
    expect(doorPat.test("await systemVisibleSourceIds(db, teamId)"), "the door must use the external-shared-only primitive, never the General-inclusive one").toBe(false);
    const scanPat = SOCIAL_SURFACE_WIRING.find(([f, p]) => f.endsWith("discover.ts") && String(p).includes("in\\("))![1];
    expect(scanPat.test('.in("id", [...opts.visibleItemIds])')).toBe(true);
    expect(scanPat.test('.gte("updated_at", since)'), "the window alone is not the actor scope").toBe(false);
  });
});
