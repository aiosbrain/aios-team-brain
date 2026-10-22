#!/usr/bin/env node
/**
 * RELPTR-4 — the three branch ROLES this repository has, named once.
 * Spec: `docs/design/cutover-prep-integration-branch.md` · runbook: `docs/RELEASING.md` §3
 *
 * WHY THREE AND NOT ONE. The first draft of this slice declared a single "integration branch" and set
 * it to `main`. Two independent pre-code reviews killed it, because `scripts/release-candidate-guard.mjs`
 * ALREADY declared the integration ref as `staging` — so there were two owners of one name holding
 * disagreeing values, and unifying them would have pointed assertion D at `main`, making it ask a
 * different question and destroying the deliberate pre-cutover red the guard exists to produce.
 *
 * They are three different jobs, and only ONE of them moves:
 *
 *   CONTRIBUTION_BASE   the branch pull requests target.  `staging` — MOVED at the cutover, 2026-09-06.
 *   INTEGRATION_BRANCH  where work accumulates before release.  `staging`, and ALREADY `staging`.
 *   RELEASE_BRANCH      what installers deploy; advances only by fast-forward to a tagged commit.  `main`.
 *
 * ⚠️ THE TRAP THIS HEADER WARNED ABOUT HAS NOW SPRUNG, and it is worth reading in the past tense.
 * Until 2026-09-06 `RELEASE_BRANCH === CONTRIBUTION_BASE === "main"`, so a consumer wired to the wrong
 * one of those two passed every value assertion — neither a "resolves to main" test nor a "derives from
 * the shared constants" test could see it. RELPTR-6 found exactly that defect in two workflow-trigger
 * assertions pinned to `[CONTRIBUTION_BASE, INTEGRATION_BRANCH]`: correct-looking, and they would have
 * reddened against correct files the moment this line moved. They now read
 * `[RELEASE_BRANCH, INTEGRATION_BRANCH]`, which is the only role pair distinct in BOTH worlds.
 *
 * The identity pin in `test/guards/branch-roles.test.ts` stubs `CONTRIBUTION_BASE` to a sentinel and
 * asserts the release guard's refs do not move. Post-cutover it guards the mirror-image mistake:
 * `CONTRIBUTION_BASE` and `INTEGRATION_BRANCH` are now BOTH `staging`, so a consumer wired to the wrong
 * one of THOSE is the invisible pair from here on.
 *
 * WHAT THIS DOES NOT BUY. It is NOT "the cutover is one edit". It makes the Node and instruction
 * consumers one edit. YAML cannot import a module, so `.github/dependabot.yml`'s `target-branch`,
 * prose that names a branch, and every branch-protection change remain separate cutover-day edits —
 * enumerated in `docs/RELEASING.md` §3.1c so they cannot be forgotten. The first draft overclaimed this
 * and review corrected it.
 */

/** The branch pull requests target. **This is the one that moves at the cutover.** */
export const CONTRIBUTION_BASE = "staging";

/** Where work accumulates before a release. Fixed — RELPTR-3's assertion D already reads it. */
export const INTEGRATION_BRANCH = "staging";

/** What installers deploy. Fixed — assertion C reads it, and it must NOT follow CONTRIBUTION_BASE. */
export const RELEASE_BRANCH = "main";

/** `refs/remotes/origin/<branch>` — the form git comparison commands need. */
export const remoteRef = (branch) => `refs/remotes/origin/${branch}`;

// A printing CLI, so a shell instruction can embed a role by command substitution rather than
// hardcoding a name. Prints the value ALONE with no banner: callers build a ref out of it, and a
// stray line would corrupt the ref rather than fail loudly.
if (process.argv.includes("--print")) {
  const roles = { contribution: CONTRIBUTION_BASE, integration: INTEGRATION_BRANCH, release: RELEASE_BRANCH };
  const asked = process.argv[process.argv.indexOf("--print") + 1];
  // `Object.hasOwn`, not truthiness: `roles["constructor"]` inherits a function from the prototype
  // chain, which is truthy — so `--print constructor` would reach `stdout.write` and throw a
  // TypeError instead of the intended diagnostic. Loud either way, but the wrong loud.
  const value = Object.hasOwn(roles, asked ?? "") ? roles[asked] : undefined;
  if (!value) {
    process.stderr.write(`unknown role ${asked ?? "(none)"} — expected one of ${Object.keys(roles).join(", ")}\n`);
    process.exit(2);
  }
  process.stdout.write(value);
}
