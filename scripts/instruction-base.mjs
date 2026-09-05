#!/usr/bin/env node
/**
 * RELPTR-5 — the scan for instructions that hardcode a branch role.
 * Spec: `docs/design/instruction-corpus-base-relative.md` · runbook: `docs/RELEASING.md` §3.1d
 *
 * ⚠️ THIS SCAN IS DELIBERATELY PARTIAL, AND THAT IS THE DESIGN. Read this before trusting a green run.
 *
 * WHY IT IS PARTIAL. Three attempts at this slice were blocked pre-code because the corpus was
 * undercounted — 14, then 31, then 34 — and each miss was a DIFFERENT SYNTACTIC FORM of one idea:
 *
 *     path form      git diff origin/main...HEAD          ← this scan sees it
 *     refspec form   git fetch origin main                ← INVISIBLE (no slash)
 *     PR-base prose  "open a PR from feat/x against main" ← INVISIBLE (no ref token)
 *     bare prose     "Branch from `origin/main`"          ← INVISIBLE (no git token)
 *
 * The class is not lexically decidable, so a scan cannot be the primary instrument: every version of
 * one gives false assurance about completeness, which is exactly what a guard must not do. The PRIMARY
 * instrument is the enumerated rewrite with per-site presence AND absence assertions in
 * `test/guards/instruction-base.test.ts`. This scan is the secondary net for the one form that IS
 * cleanly decidable, and its failure message says so out loud.
 *
 * WHY IT MATCHES THE LITERALS AND NOT THE RESOLVED BASE. Both reviewers caught this. Keyed on
 * `origin/${CONTRIBUTION_BASE}`, the scan would after the cutover look for `origin/staging` and stop
 * seeing a reintroduced `git diff origin/main...HEAD` — the single most likely muscle-memory
 * regression, invisible at exactly the moment it starts mattering. So it matches the ROLE BRANCH
 * LITERALS, both of them, always.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Both role-branch literals. Not the resolved base — see the header. */
export const ROLE_REFS = /origin\/(main|staging)\b/;

/**
 * A `git` SUBCOMMAND invocation on the same line. Declared verbatim because a guard whose rule is not
 * stated cannot be reviewed, and because the `\s+` is load-bearing: it is what keeps this from firing
 * on `git(dir, "update-ref", "refs/remotes/origin/main", …)` in `test/guards/branch-roles.test.ts` —
 * a JS helper call, and a DELIBERATE permanent hardcode of the release ref — and on prose that says
 * "carries no `git` token". Both were named by reviewers as false positives a looser `\bgit\b` causes.
 */
export const GIT_INVOCATION = /\bgit\s+[a-z-]+\b/;

/** Paths whose hardcoded refs are correct and must stay. Each entry has a reason. */
export const EXCLUSIONS = [
  "docs/design/", // history: a design doc recording what an instruction USED to say is correct
  "docs/archive/", // archived, and banner-marked non-executable
  ".context/", // untracked scratch; listed so a future fs-walk cannot pick it up
  "test/guards/branch-roles.test.ts", // the fixed RELEASE ref in RELPTR-4's identity fixture
  "test/guards/instruction-base.test.ts", // intentional literal regression fixtures
  "scripts/instruction-base.mjs", // this file documents the forms it hunts
];

/** Is this line an operative, hardcoded role-branch reference? The declared predicate, exactly. */
export function isOperativeLine(line) {
  return ROLE_REFS.test(line) && GIT_INVOCATION.test(line);
}

export const isExcluded = (path) => EXCLUSIONS.some((e) => (e.endsWith("/") ? path.startsWith(e) : path === e));

/**
 * Scan an INJECTED inventory of `{ path, content }`. Injected rather than read from disk so the roots
 * can be proven covered with fixtures — production supplies the real inventory below, and the test
 * asserts THAT separately, because a fixture written to disk would not be tracked and so could never
 * appear in a `git ls-files` scan.
 */
export function scanInventory(records) {
  const hits = [];
  for (const { path, content } of records) {
    if (isExcluded(path)) continue;
    String(content)
      .split("\n")
      .forEach((line, i) => {
        if (isOperativeLine(line)) hits.push({ path, line: i + 1, text: line.trim() });
      });
  }
  return hits;
}

/** Every tracked file, as the scan's production inventory. */
export function trackedInventory(cwd = undefined) {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", cwd }).replace(/\n$/, "");
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", cwd: root }).split("\0").filter(Boolean);
  return [...new Set(files)].filter((path) => !isExcluded(path)).map((path) => {
    try {
      return { path, content: readFileSync(join(root, path), "utf8") };
    } catch (cause) {
      throw new Error(`Cannot read tracked instruction inventory path ${path}`, { cause });
    }
  });
}

/** The failure text. It states the scan's LIMITS, so nobody can read a green run as completeness. */
export function report(hits) {
  if (hits.length === 0) {
    return (
      "no hardcoded role-branch git commands found.\n" +
      "NOTE: this scan is PARTIAL BY DESIGN. It does not see `git fetch origin main` (refspec form), " +
      "PR-base prose, or a bare `origin/main` with no git subcommand. Those are held by the per-site " +
      "presence and absence assertions in test/guards/instruction-base.test.ts, not by this scan."
    );
  }
  return [
    `${hits.length} instruction(s) hardcode a role branch in a git command:`,
    ...hits.map((h) => `  ${h.path}:${h.line}  ${h.text}`),
    "Resolve the contribution base instead — see scripts/branches.mjs and docs/RELEASING.md §3.1d.",
    "PARTIAL BY DESIGN: does not cover refspec form, PR-base prose, or bare refs without a git subcommand. Use the per-site presence and absence assertions too.",
  ].join("\n");
}

if (process.argv.includes("--run")) {
  const hits = scanInventory(trackedInventory());
  console.log(report(hits));
  process.exit(hits.length === 0 ? 0 : 1);
}
