import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * TICKSTALL-1 criteria 10 and 11 — two call-site facts nothing else pins.
 *
 * (11) ONE parse site for `CONTEXT_BACKFILL_BUDGET_MS`. A second local `process.env` read is how two
 * components come to silently disagree about a budget; this repo has the `PRET_FLIP_MAX_PER_TICK`
 * precedent for exactly that guard.
 *
 * (10) The scheduler must pass REAL counts to `recordIngestRun`. The leg previously hardcoded
 * `created: 0` at both sites, so a row read identically whether the pass drained 2600 items or spun
 * for an hour — which is why a 59-minute stage ran for six days unnoticed. That is a comment-and-
 * discipline invariant otherwise, and discipline is what failed the first time.
 */
const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("guard: the context-backfill budget has ONE parse site", () => {
  it("only lib/projects/context/backfill-budget reads the env var", () => {
    const hits = ["lib", "app", "scripts"]
      .flatMap((d) => sourceFiles(join(ROOT, d)))
      .filter((f) => readFileSync(f, "utf8").includes("CONTEXT_BACKFILL_BUDGET_MS"))
      .map((f) => f.slice(ROOT.length + 1));
    expect(hits, "a second parse site would let two components disagree about the budget").toEqual([
      "lib/projects/context/backfill-budget.ts",
    ]);
  });

  it("the scan is non-vacuous — it really does find that one file", () => {
    // Without this, a renamed env var makes the assertion above pass with an empty list forever.
    expect(read("lib/projects/context/backfill-budget.ts")).toContain("CONTEXT_BACKFILL_BUDGET_MS");
  });
});

describe("guard: the context-backfill leg records what it actually did", () => {
  const src = read("lib/ingest/scheduler.ts");
  /** The `runContextBackfill` body, so these cannot be satisfied by another leg's code. */
  const block = (() => {
    const start = src.indexOf("async function runContextBackfill");
    expect(start, "runContextBackfill must exist").toBeGreaterThan(-1);
    return src.slice(start, src.indexOf("async function runMeetingNotesBackfill", start));
  })();

  /**
   * The SUCCESS-path recording only, COMMENTS STRIPPED.
   *
   * Two separate reasons, both learned the hard way here. The outer `catch` legitimately records
   * `created: 0` — it threw before doing anything measurable, so zero is true there, not a
   * placeholder; scoping to the try body is the difference between pinning the defect and banning a
   * string. And scanning raw source made this guard fail against its own DOCUMENTATION (a comment
   * explaining the old `created: 0` defect). The mirror of that is worse: a positive assertion
   * satisfied by a comment is a guard that proves nothing, so every assertion below reads code only.
   */
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const tryBody = stripComments(block.slice(0, block.indexOf("} catch (err) {")));

  it("passes the REAL membership count, not a hardcoded zero", () => {
    expect(tryBody).toMatch(/created: o\.membershipsCreated/);
    expect(tryBody, "the hardcoded created: 0 is the defect that hid a 59-minute stage for six days")
      .not.toMatch(/created: 0/);
    // …and the instance-wide row sums the real per-team counts rather than reporting its own zero.
    expect(tryBody).toMatch(/created: r\.outcomes\.reduce/);
  });

  it("writes the per-team row with the EXACT keys the cursor read filters on", () => {
    // The silent-regression path Fable found. `readTeamBackfillState` filters on
    // team_id / source='context_backfill' / trigger='scheduler'. If this writer ever drifted to
    // `teamId: null` or another source, the read would match NOTHING, the cursor would come back null
    // every tick, and RESTART-FROM-NULL — the precise defect this PR exists to kill — would return
    // with every test still green, because the dm tier persists its own rows rather than going
    // through this call site.
    expect(tryBody).toMatch(/teamId: o\.teamId/);
    expect(tryBody).toMatch(/source: "context_backfill"/);
    expect(tryBody).toMatch(/trigger: "scheduler"/);
  });

  it("records the distinct facts — truncated, drained, elapsedMs, excludeShadows — plus the resume cursor", () => {
    // `shortCircuit` is deliberately GONE (TICKSTALL-2 removed the heuristic it reported). It is not
    // pinned false: a flag frozen at one value is a dead signal readers may still trust.
    expect(tryBody, "shortCircuit was retired with the heuristic").not.toMatch(/shortCircuit/);
    for (const key of ["truncated:", "drained:", "cursor:", "elapsedMs:", "excludeShadows:", "retractedUnits:"]) {
      expect(tryBody, `meta must carry ${key}`).toContain(key);
    }
  });

  it("a budget-truncated pass is NOT routed through the failure path", () => {
    // `ok` must come from the outcome's own ok, never from `truncated`. Routing truncation into
    // ok:false would put a healthy leg into the BANNERFLAP-1 streak and redden the banner — the exact
    // bug the sibling ticket just removed.
    expect(tryBody).toMatch(/ok: o\.ok/);
    expect(tryBody).not.toMatch(/ok: !.*truncated/);
  });

  it("bounds the stage with a SMALL batch, so the after-batch check cannot overshoot by ~11 minutes", () => {
    expect(tryBody).toMatch(/batchSize: 100/);
  });
});
