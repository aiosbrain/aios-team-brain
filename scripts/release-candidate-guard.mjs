#!/usr/bin/env node
/**
 * RELPTR-3 — the release-candidate gate.
 * Spec: `docs/design/release-pointer-cutover-guard.md`.
 *
 * THE QUESTION THIS ANSWERS, AND WHY IT IS ASKED HERE.
 * Option B (`docs/RELEASING.md` §3) says `main` advances ONLY by fast-forward to a commit that was
 * already tagged on the integration branch. Branch protection expresses WHO may push; only a check can
 * express WHAT may land. But a check cannot gate a push it is triggered BY: GitHub accepts a direct
 * push to a protected branch only if the pushed commit ALREADY carries its required contexts, so a
 * workflow on `push: main` runs after the commit has landed. It can alarm; it cannot gate.
 *
 * So this runs on the `v*` TAG PUSH — the event that creates a candidate — and validates that event's
 * own commit. A tag-push run's `GITHUB_SHA` is the PEELED commit, and its check run attaches to that
 * commit, which is the same SHA protection evaluates when `main` is later fast-forwarded onto it.
 *
 * WHAT THE FIRST TWO DESIGNS GOT WRONG (both caught pre-code, by two different models):
 *   - Round 1 specced a `push: main` guard plus an arming tag. It could not gate; the arm was
 *     forgeable (a same-repo PR can request `contents: write` and touch `refs/tags/*` during its OWN
 *     PR run) and deletable; and it had a WRONG-GREEN path — validating remote `main` while running on
 *     an integration-branch push attaches a green to a candidate it never examined, so protection then
 *     accepts that candidate on the strength of a check that never looked at it.
 *   - Round 2 cut assertion D. That was an over-correction: A+B+C certify "some descendant of `main`",
 *     not "the release". Open a PR and never merge it, let the pull_request contexts attach, tag that
 *     head — and a never-integrated commit passes. D is what makes it the RIGHT commit.
 *
 * THERE IS NO ARMING FLAG, deliberately. Not a file (a PR can edit it — slice 1 round 3), not a tag
 * (a PR-run workflow can delete it — round 1). The question above is meaningful today and after the
 * cutover, so nothing needs switching on.
 */

import { execFileSync } from "node:child_process";
import { INTEGRATION_BRANCH, RELEASE_BRANCH, remoteRef } from "./branches.mjs";

/** A release tag is EXACTLY `vX.Y.Z`. No pre-release, no build metadata, no leading zeros. */
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/**
 * THE PURE DECISION. Every input is a fact someone else measured, so this is testable without git,
 * without a network, and without a repository in any particular state.
 *
 * Returns `{ verdict, failures }` rather than throwing: the caller decides the exit code, and the
 * failures list is what a human reads in the Actions log.
 */
export function releaseCandidateVerdict({
  tagName,
  tagObjectType,
  taggedTreeVersion,
  mainIsAncestor,
  reachableFromIntegration,
}) {
  const failures = [];

  // A — the tag itself. Name first, then shape: a malformed name makes B's expectation meaningless,
  // so reporting both would be one fixture tripping two terms and would prove only the first.
  if (!RELEASE_TAG.test(String(tagName))) {
    failures.push(
      `A: ${tagName} is not exactly vX.Y.Z. Pre-release and build-metadata tags are refused rather ` +
        `than skipped, so the refusal is LOUD — use a non-\`v\` prefix (\`rc/\`, \`cutover/\`) for ` +
        `anything that is not a release.`
    );
  } else if (tagObjectType !== "tag") {
    // The corpus is genuinely mixed — `v0.12.0` is a `tag` object, `v0.10.0` is a `commit`.
    failures.push(
      `A: ${tagName} is a LIGHTWEIGHT tag (object type ${tagObjectType ?? "unknown"}). A release tag ` +
        `must be annotated, so it carries an author, a date and a message.`
    );
  }

  // B — the tag name and the tree it points at must agree. Checked in BOTH directions: a
  // one-directional check passes the half-cut release it exists to catch.
  if (RELEASE_TAG.test(String(tagName))) {
    const expected = String(tagName).slice(1);
    if (taggedTreeVersion !== expected) {
      failures.push(
        `B: ${tagName} points at a tree whose package.json version is ${taggedTreeVersion ?? "absent"}, ` +
          `not ${expected}. Either the version bump is missing or the tag is on the wrong commit.`
      );
    }
  }

  // C — a fast-forward is POSSIBLE. This is an early signal, not the enforcement: git's non-force
  // push plus force-push-off is what actually makes the advance a fast-forward.
  if (mainIsAncestor !== true) {
    failures.push(
      `C: the current \`main\` is not an ancestor of this commit, so advancing \`main\` to it would ` +
        `not be a fast-forward.`
    );
  }

  // D — it is the RIGHT commit. Without this, A+B+C accept any descendant of `main`, including a
  // commit from a pull request that was never merged.
  if (reachableFromIntegration !== true) {
    failures.push(
      `D: this commit is not reachable from the integration branch, so it never crossed integration. ` +
        `A+B+C alone certify only "some descendant of main", not "the release".`
    );
  }

  return { verdict: failures.length === 0 ? "PASS" : "FAIL", failures };
}

/* ─────────────────────────── the thin measuring shell ─────────────────────────── */

// `cwd` is threaded through rather than relying on the process's directory SO THAT THE WIRING CAN BE
// TESTED. That is not incidental: the pure decision below takes `reachableFromIntegration` as a
// boolean, so nothing about the argument order of the `merge-base` call that COMPUTES it is pinned by
// those tests — and an inverted order would return `true` in today's pre-cutover graph (`staging` is
// behind `main`, so `staging` IS an ancestor of the candidate). It would pass silently, on the one
// assertion two review rounds existed to restore.
const gitIn = (cwd) => (...args) => execFileSync("git", args, { encoding: "utf8", cwd }).trim();

/**
 * Resolve the tag the EVENT carried, and bind it to the immutable SHA the check will attach to.
 *
 * WHY THE EQUALITY CHECK: resolving `refs/tags/<name>^{commit}` at job time is a race. The tag can be
 * force-moved between the push and this read, in which case the green attaches to the ORIGINAL commit
 * while this job validated a different one — the same event-to-validated-SHA split that made round 1
 * decline. Fails closed on any disagreement.
 *
 * WHY IT RE-FETCHES: `actions/checkout` is known to re-fetch the triggering tag as
 * `+<commit>:refs/tags/<tag>`, which turns an annotated tag into a lightweight one LOCALLY. Reading
 * the object type from checkout's leftovers would redden every valid annotated release.
 */
export function resolveEventTag({ ref, sha, remote = "origin", cwd = undefined }) {
  const git = gitIn(cwd);
  const name = String(ref ?? "").replace(/^refs\/tags\//, "");
  if (!name || name === String(ref)) {
    throw new Error(`this gate runs on tag pushes only; GITHUB_REF was ${ref ?? "unset"}`);
  }

  // Force the real object back into place, overwriting whatever checkout left there.
  git("fetch", "--force", remote, `+refs/tags/${name}:refs/tags/${name}`);

  const objectType = git("cat-file", "-t", `refs/tags/${name}`);
  const peeled = git("rev-parse", `refs/tags/${name}^{commit}`);

  if (peeled !== String(sha)) {
    throw new Error(
      `refusing: refs/tags/${name} peels to ${peeled} but this run's GITHUB_SHA is ${sha}. The tag ` +
        `moved after the push, so the check would attach to a commit this job did not validate.`
    );
  }
  return { name, objectType, commit: peeled };
}

function taggedTreeVersion(commit, cwd) {
  try {
    return JSON.parse(gitIn(cwd)("show", `${commit}:package.json`)).version ?? null;
  } catch {
    return null;
  }
}

/** True iff `maybeAncestor` is an ancestor of `descendant` — or the same commit. */
function isAncestor(maybeAncestor, descendant, cwd) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", maybeAncestor, descendant], { stdio: "ignore", cwd });
    return true;
  } catch {
    return false;
  }
}

export function main({
  ref = process.env.GITHUB_REF,
  sha = process.env.GITHUB_SHA,
  remote = "origin",
  // RELPTR-4: these were hardcoded here, which made this file an UNDECLARED SECOND OWNER of the
  // integration branch — two names for one concept, holding different values. They now come from
  // `scripts/branches.mjs`. Note WHICH role each takes: assertion C reads the RELEASE branch and
  // assertion D the INTEGRATION branch. Until the 2026-09-06 cutover RELEASE_BRANCH and CONTRIBUTION_BASE were both
  // `main`, so wiring C to the contribution base would be invisible until the cutover moved it.
  // `test/guards/branch-roles.test.ts` pins that distinction with a sentinel.
  mainRef = remoteRef(RELEASE_BRANCH),
  integrationRef = remoteRef(INTEGRATION_BRANCH),
  cwd = undefined,
  log = console.log,
} = {}) {
  const tag = resolveEventTag({ ref, sha, remote, cwd });

  const facts = {
    tagName: tag.name,
    tagObjectType: tag.objectType,
    taggedTreeVersion: taggedTreeVersion(tag.commit, cwd),
    // C: is `main` an ancestor OF the candidate — i.e. can `main` fast-forward to it.
    mainIsAncestor: isAncestor(mainRef, tag.commit, cwd),
    // D: is the candidate an ancestor of INTEGRATION — i.e. did it cross integration. The argument
    // order is the opposite of C's and that is the whole point; see `gitIn`'s note.
    reachableFromIntegration: isAncestor(tag.commit, integrationRef, cwd),
  };

  const { verdict, failures } = releaseCandidateVerdict(facts);

  log(`release-candidate gate — ${tag.name} → ${tag.commit}`);
  for (const [k, v] of Object.entries(facts)) log(`  ${k}: ${JSON.stringify(v)}`);
  log(`  verdict: ${verdict}`);
  for (const f of failures) log(`  ✗ ${f}`);

  return { verdict, failures, facts };
}

// Entry — a POSITIVE ACK TOKEN, not a `process.argv[1]` comparison against `import.meta.url`.
// This repository has already shipped that comparison once and been bitten: from a symlinked path, or
// one containing a space, it matched nothing, printed nothing and exited **0** — which the shell reads
// as a green light. `pathToFileURL` fixes the encoding half and not the symlink half. Requiring an
// explicit `--run` inverts the failure: forget it and the module does nothing at all (importing it
// under test is silent by construction), while the workflow that does pass it always executes.
if (process.argv.includes("--run")) {
  const { verdict } = main();
  process.exit(verdict === "PASS" ? 0 : 1);
}
