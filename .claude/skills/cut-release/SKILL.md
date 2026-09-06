---
name: cut-release
description: >
  Cut a release: declare the tag, bump the three version sites, date the
  CHANGELOG, tag the commit on the integration branch, wait for the
  release-candidate gate, then FAST-FORWARD the release branch onto that exact
  tagged commit. Use when asked to "cut a release", "ship v0.13.0", "release
  from staging", "tag a release", or /cut-release. The fast-forward is the step
  that makes a tag a release — everything before it only produces a tag.
  Verification-heavy and destructive-step-light: it never merges into the
  release branch, never runs `pg:schema` against prod, and never touches
  Railway.
---

# Cut a release — integration branch → release branch

The spine:

> **check the preconditions → declare the tag → bump + date → tag the commit →
> WAIT for the gate → fast-forward the release branch → publish → watch the
> migration lane**

**Resolve the branch roles, never hardcode them** (`scripts/branches.mjs`):

```bash
INTEGRATION=$(node scripts/branches.mjs --print integration)   # staging
RELEASE=$(node scripts/branches.mjs --print release)           # main
```

`docs/RELEASING.md` §2 is the runbook this skill executes; §3.1a explains the
gate's four assertions. When the two disagree, the runbook wins and this file
is stale — say so rather than following it.

---

## 0. Preconditions — three, and two of them have failed in practice

Check all three BEFORE touching a version number. Each is one command.

**A. The release branch must be an ANCESTOR of the integration branch.**

```bash
git fetch origin --quiet
git merge-base --is-ancestor "origin/$RELEASE" "origin/$INTEGRATION" \
  && echo "OK — ancestry holds" || echo "STOP — diverged"
```

If it prints STOP, **no tag you cut can pass the gate**: assertion C wants the
release branch to be an ancestor of the tagged commit and assertion D wants that
commit reachable from the integration branch, and nothing satisfies both across
a divergence. This is not theoretical — it happened **twice in one day** on
2026-09-06 (repaired by #681 and #684), both times because a pull request landed
on the release branch after the cutover.

The repair is a back-merge, and the merge method is load-bearing:

```bash
gh pr create --base "$INTEGRATION" --head "$RELEASE" --title "reconcile: restore release ancestry"
# merge it with a MERGE COMMIT, never --squash
```

**A squash defeats the entire purpose** — it creates a new SHA, so the release
branch is still not an ancestor. Land the reconcile, re-run the check, then
continue.

**B. Nothing unreleased is stranded.** `git log --oneline "$RELEASE".."$INTEGRATION"`
should be exactly what you intend to ship. Read it; the CHANGELOG section you
are about to write has to be true, and no check verifies that.

**C. The previous tag is declared.** `DEFAULT_TAGS` in
`scripts/migrate-from-existing.mjs` must already contain every cut tag. If the
newest cut tag is missing, fix that first — see step 1 for why.

---

## 1. Declare the tag BEFORE cutting it

Add the new tag to `DEFAULT_TAGS` in `scripts/migrate-from-existing.mjs` and land
that pull request into the **integration** branch.

**Why this order and not the obvious one:** the migration lane runs in `ci.yml`
on `pull_request`. Cutting a tag that `DEFAULT_TAGS` does not declare throws
`DEFAULT_TAGS is stale` **on every open pull request in the repo** — not just
yours. The lane deliberately *skips* a declared-but-uncut tag with a notice, and
that pending slot is exactly the affordance that makes declare-then-cut safe.

Same pull request, two more things:

- **Bump the version at all THREE sites** — `package.json` `.version`,
  `package-lock.json` `.version`, and `package-lock.json` `.packages[""].version`.
  Bumping only the first is a mistake this repo has already made: the version sat
  at `0.10.0` for 23 days and two releases' worth of work.
  `test/guards/release-version-agreement.test.ts` fails the build if the three
  disagree, or if the newest declared tag is not `v${package.json.version}`.
- **Move `CHANGELOG.md`'s `[Unreleased]` into `## [X.Y.Z] — YYYY-MM-DD`** and
  leave an empty `[Unreleased]` above it. A check reads the heading; it verifies
  *presence*, not truth. Anything merged before you cut ships whether or not it
  is listed.

---

## 2. Tag the commit on the integration branch

```bash
git tag -a "v<X.Y.Z>" -m "v<X.Y.Z>" "origin/$INTEGRATION"
git push origin "v<X.Y.Z>"
```

**Annotated (`-a`), and exactly `vX.Y.Z`** — no pre-release suffix, no build
metadata, no leading zeros. Assertion A rejects anything else.

Pushing the tag runs `.github/workflows/release-candidate.yml`. `ci.yml` fires on
branches only, so **the tag push runs the gate and nothing else**.

---

## 3. WAIT for `Release candidate gate` — and know that nothing enforces the wait

```bash
gh run list --repo <owner>/<repo> --workflow=release-candidate.yml --limit 1 \
  --json status,conclusion,headSha
```

Four assertions: **A** the tag is annotated and exactly `vX.Y.Z` · **B** the
tagged tree's `package.json` matches the tag · **C** the release branch is an
ancestor of the tagged commit · **D** the commit is reachable from the
integration branch. A+B+C alone certify *"some descendant of the release
branch"*; **D** is what makes it the right commit.

⚠️ **THE WAIT IS HUMAN DISCIPLINE.** Measured 2026-09-06: `Release candidate
gate` is **not** a required context on the release branch, `enforce_admins` is
false, and there is no bypass allowance. So a non-admin's fast-forward is refused
by "require a pull request" whatever the contexts say, and **an admin's push
bypasses everything — including a pending or red gate.** Do not read a green
branch-protection UI as having checked this for you. (RELPTR-8 tracks closing it.)

**Do not fast-forward past a red assertion.** A red A/B/C means the tag itself is
wrong — delete it, fix, re-tag. A red D after a green precondition A means
something changed underneath you; re-check ancestry.

---

## 4. Fast-forward the release branch — the step that makes it a release

```bash
git push origin "v<X.Y.Z>^{commit}:$(node scripts/branches.mjs --print release)"
```

**Everything before this produces a tag; nothing before it moves what installers
deploy.** This step was missing from the runbook entirely until a review caught
that following §2 as written would leave installers on the pre-cutover release
branch indefinitely, with every check green.

- `^{commit}` peels the annotated tag to the commit — pushing the tag object
  itself would not advance a branch.
- The destination resolves the ROLE. Hardcoding `main` here is the thing the
  branch-roles module exists to prevent.
- It is a **fast-forward, not a merge**. The release branch never gains a commit
  that was not reviewed on the integration branch. If git refuses it as
  non-fast-forward, ancestry broke — go back to precondition A.

This push triggers the release deploy: Railway builds the release branch and runs
`npm run pg:schema` as its `preDeployCommand`, **from the deployed artifact's
tree**.

⛔ **Never run `npm run pg:schema` against prod by hand.** It loads from *your*
checkout (`loadSchema({ cwd = process.cwd() })`), and post-cutover your checkout
is routinely AHEAD of the tag — so a manual run applies unreleased migrations to
production. Verify the deploy's preDeploy step instead.

---

## 5. Publish, then watch the thing that actually tests the release

Publish the GitHub Release from the tag with the CHANGELOG section as its body.

Then **watch the migration lane on the next pull request or branch push.** It
exercises the previous-tag → new-tag upgrade against a real database, and it is
the only evidence an existing install can upgrade. Read its output rather than
assuming: on 2026-09-06 a staging refresh proved a v0.10-era database **could
not** reach current in one deploy — the PRET-6 migration refused, correctly, and
needed an intermediate step.

---

## 6. Close the loop

Set the release row's `Status` to `done` in `3-log/tasks.md`, `aios push`
(dry-run first), and **read the status back** — a push that reported `ok` is not
proof the row moved. Merge automation does not close workspace-pushed rows; they
resolve `linked`, not `applied`.

---

## What this skill refuses to do

- **Merge anything into the release branch.** It only ever fast-forwards.
- **Run `pg:schema` against production**, for the reason in step 4.
- **Touch Railway** beyond read-only verification — no `up`, `redeploy`, `down`,
  `delete`.
- **Cut the tag before the declare-and-bump pull request has landed.**
- **Fast-forward past a red or pending gate**, even though nothing stops it.

## Failure modes this sequence exists to catch

| Failure | Caught by |
|---|---|
| Release branch diverged; no candidate can pass | precondition A |
| A back-merge squashed, so ancestry is still broken | precondition A's explicit merge-method note |
| `DEFAULT_TAGS is stale` on every open PR | step 1's declare-then-cut order |
| Version bumped at one site of three | step 1 + `release-version-agreement` guard |
| A tag that is never actually released | step 4 existing at all |
| Unreleased migrations applied to prod by hand | step 4's ⛔ |
| A release nobody proved is installable | step 5's migration lane |
