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
 *   CONTRIBUTION_BASE   the branch pull requests target.  `main` TODAY → becomes `staging` at cutover.
 *   INTEGRATION_BRANCH  where work accumulates before release.  `staging`, and ALREADY `staging`.
 *   RELEASE_BRANCH      what installers deploy; advances only by fast-forward to a tagged commit.  `main`.
 *
 * ⚠️ TODAY `RELEASE_BRANCH === CONTRIBUTION_BASE === "main"`, AND THAT IS A TRAP. Wiring a consumer to
 * the wrong one of those two is invisible to every value assertion — both reviewers found this, and
 * neither a "resolves to main" test nor a "derives from the shared constants" test can see it. It would
 * surface on cutover day, when `CONTRIBUTION_BASE` moves and the consumer silently follows it. The
 * identity pin in `test/guards/branch-roles.test.ts` stubs `CONTRIBUTION_BASE` to a sentinel and
 * asserts the release guard's refs do not move; that is the only thing standing between a one-token
 * typo and a broken release check months from now.
 *
 * WHAT THIS DOES NOT BUY. It is NOT "the cutover is one edit". It makes the Node and instruction
 * consumers one edit. YAML cannot import a module, so `.github/dependabot.yml`'s `target-branch`,
 * prose that names a branch, and every branch-protection change remain separate cutover-day edits —
 * enumerated in `docs/RELEASING.md` §3.2 so they cannot be forgotten. The first draft overclaimed this
 * and review corrected it.
 */

/** The branch pull requests target. **This is the one that moves at the cutover.** */
export const CONTRIBUTION_BASE = "main";

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
  const value = roles[asked];
  if (!value) {
    process.stderr.write(`unknown role ${asked ?? "(none)"} — expected one of ${Object.keys(roles).join(", ")}\n`);
    process.exit(2);
  }
  process.stdout.write(value);
}
