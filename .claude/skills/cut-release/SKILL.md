---
name: cut-release
description: >
  Cut a release: declare the tag, bump the three version sites, date the
  CHANGELOG, verify the candidate LOCALLY, tag the commit on the integration
  branch, wait for the release-candidate gate, then FAST-FORWARD the release
  branch onto that exact tagged commit. Use when asked to "cut a release",
  "ship v0.13.0", "release from staging", "tag a release", or /cut-release.
  The fast-forward is the step that makes a tag a release — everything before
  it only produces a tag. A pushed `v*` tag is PERMANENT (protected ruleset,
  no bypass), so the local pre-push check is the last chance to be wrong
  cheaply. Never merges into the release branch and never runs `pg:schema`
  against prod.
---

# Cut a release — integration branch → release branch

The spine:

> **preconditions → declare + bump + date → VERIFY LOCALLY → tag → wait for the
> gate → fast-forward the release branch → verify the deploy → publish → watch
> the migration lane**

**Resolve the branch roles, never hardcode them.** Use the `$root` form so this
works from any cwd — a bare relative path exits 1 with empty stdout from a nested
directory, which turns precondition A into a false "diverged":

```bash
root="$(git rev-parse --show-toplevel)"
INTEGRATION="$(node "$root/scripts/branches.mjs" --print integration)"   # staging
RELEASE="$(node "$root/scripts/branches.mjs" --print release)"           # main
```

`docs/RELEASING.md` §2 is the runbook this executes; §3.1a explains the gate.
When the two disagree, the runbook wins and this file is stale — say so rather
than following it.

---

## ⛔ The one irreversible step

**A pushed `v*` tag cannot be deleted or moved by anyone**, including admins:
ruleset `22363258` is `active` over `refs/tags/v*` with `deletion`,
`update` and `non_fast_forward`, and **zero bypass actors** (verified). If you
push a tag and the gate reddens on A, B or C, that version number is **burned** —
the recovery is to fix forward and cut the next patch number, not to re-tag.

Everything before the tag push is cheap to get wrong. Everything after is not.
That is why step 3 exists.

---

## 0. Preconditions — three, all `origin/` refs

**Always compare remote refs.** Local branches in a worktree drift arbitrarily:
measured in a real worktree, `main..staging` reported **221** commits while
`origin/main..origin/staging` reported **6**. The local answer is not wrong-ish,
it is unrelated.

```bash
git fetch origin --quiet
```

**A. The release branch must be an ANCESTOR of the integration branch.**

```bash
git merge-base --is-ancestor "origin/$RELEASE" "origin/$INTEGRATION" \
  && echo "OK — ancestry holds" || echo "STOP — diverged"
```

STOP means **no tag you cut can pass the gate**: assertion C wants the release
branch to be an ancestor of the tagged commit and D wants that commit reachable
from the integration branch, and nothing satisfies both across a divergence.

This is not theoretical. It happened twice on 2026-09-06 — once as the planned
pre-cutover reconcile (#681), and once **after** the cutover when #683 was opened
against the release branch instead of the integration branch (repaired by #684).
The post-cutover case is the one that will recur until RELPTR-8 lands, because an
admin can still push to the release branch.

Repair, and the merge method is load-bearing:

```bash
gh pr create --base "$INTEGRATION" --head "$RELEASE" \
  --title "reconcile: restore release ancestry" \
  --body "$(cat <<'EOF'
Back-merge to restore ancestry so release candidates can pass assertions C and D.

## Review — Reviewed by prior-PR review evidence (no new diff) — verdict every constituent commit was reviewed on its own PR; this back-merge adds no unreviewed code.

The diff is exactly the release-branch-only commits and nothing else; a conflict
would invalidate this line and a real review would be owed.
EOF
)"
```

Two things that bite here:

- **Merge it with a MERGE COMMIT — not squash, not rebase.** Both of those mint
  new SHAs, so the release branch is *still* not an ancestor. The repair that
  looks like a fix and isn't. `gh pr merge <n> --merge`.
- **The body needs the attestation line above.** The integration branch requires
  `PR records a diff review`; a bare `gh pr create` produces a PR that cannot
  merge.

**B. Nothing unreleased is stranded.**

```bash
git log --oneline "origin/$RELEASE..origin/$INTEGRATION"
```

Read it — the CHANGELOG section you are about to write has to be true, and no
check verifies that.

**C. Every already-cut tag is declared.** `DEFAULT_TAGS` in
`scripts/migrate-from-existing.mjs` must contain every tag that exists. Also
worth a glance: GitHub *Releases* currently stop at `v0.10.0` while `v0.11.0` and
`v0.12.0` exist as tags only — publishing (step 6) is the step that has been
skipped before.

---

## 1. Declare the tag BEFORE cutting it

One pull request into the **integration** branch, carrying three things:

- **Add the new tag to `DEFAULT_TAGS`** in `scripts/migrate-from-existing.mjs`.
  The migration lane runs in `ci.yml` on `pull_request`, and cutting a tag it
  does not declare throws `DEFAULT_TAGS is stale` **on every open pull request in
  the repo** — not just yours. The lane deliberately *skips* a declared-but-uncut
  tag with a notice; that pending slot is what makes declare-then-cut safe.
- **Bump all THREE version sites** — `package.json` `.version`,
  `package-lock.json` `.version`, `package-lock.json` `.packages[""].version`.
  Bumping one is a mistake already made here: the version sat at `0.10.0` for 23
  days and two releases' worth of work. `test/guards/release-version-agreement.test.ts`
  fails the build if the three disagree, or if the newest declared tag is not
  `v${package.json.version}`.
- **Move `CHANGELOG.md`'s `[Unreleased]` into `## [X.Y.Z] — YYYY-MM-DD`**, leaving
  an empty `[Unreleased]`. The check reads the heading and verifies *presence*,
  not truth.

Land it. Then continue — and re-fetch, because the remote just moved.

---

## 2. VERIFY LOCALLY — the last cheap moment

```bash
git fetch origin --quiet
CANDIDATE="$(git rev-parse "origin/$INTEGRATION")"
VERSION="v$(git show "$CANDIDATE:package.json" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"

echo "candidate: $CANDIDATE"
echo "version in the TAGGED TREE: $VERSION   (must equal the tag you are about to push)"
git merge-base --is-ancestor "origin/$RELEASE" "$CANDIDATE" && echo "C ok" || echo "C FAILS"
git merge-base --is-ancestor "$CANDIDATE" "origin/$INTEGRATION" && echo "D ok" || echo "D FAILS"
```

**This exists because the tag push is irreversible.** The failure it prevents is
concrete and easy to walk into: fetch at precondition A, land the bump pull
request at step 1, then tag `origin/$INTEGRATION` from the *stale* local ref — you
tag the pre-bump commit, whose `package.json` still reads the old version,
assertion **B** reddens, and the tag cannot be deleted. The version number is
gone.

`$VERSION` must equal the tag you are about to push. If it does not, you are
about to tag the wrong commit.

---

## 3. Tag the commit

```bash
git tag -a "$VERSION" -m "$VERSION" "$CANDIDATE"
git push origin "$VERSION"
```

**Annotated (`-a`), exactly `vX.Y.Z`** — no pre-release suffix, no build metadata,
no leading zeros; assertion A rejects anything else. Tag `$CANDIDATE` (the SHA you
just verified), not a branch name that may have moved since.

`ci.yml` fires on branches only, so the tag push runs the release-candidate gate
and nothing else.

---

## 4. Wait for the gate — nothing enforces this wait

```bash
gh run list --repo <owner>/<repo> --workflow=release-candidate.yml --limit 5 \
  --json status,conclusion,headSha \
  --jq ".[] | select(.headSha == \"$(git rev-parse "$VERSION^{commit}")\")"
```

Match on `headSha` — `--limit 1` can hand you another tag's run.

Four assertions: **A** annotated and exactly `vX.Y.Z` · **B** the tagged tree's
`package.json` matches the tag · **C** the release branch is an ancestor of the
tagged commit · **D** the commit is reachable from the integration branch. A+B+C
alone certify *"some descendant of the release branch"*; **D** is what makes it
the right commit.

⚠️ **THE WAIT IS HUMAN DISCIPLINE.** Measured 2026-09-06: `Release candidate gate`
is **not** a required context on the release branch, `enforce_admins` is false,
and there is no bypass allowance. A non-admin's fast-forward is refused by
"require a pull request" whatever the contexts say; **an admin's push bypasses
everything, including a pending or red gate.** Do not read a green
branch-protection UI as having checked this. RELPTR-8 tracks closing it.

**Red A/B/C means the tag is wrong — and you cannot re-tag** (see the ⛔ above).
Fix forward on the integration branch and cut the next patch number.

---

## 5. Fast-forward the release branch — the step that makes it a release

```bash
git push origin "$VERSION^{commit}:$RELEASE"
```

**Everything before this produces a tag; nothing before it moves what installers
deploy.** This step was missing from the runbook entirely until a review caught
that following §2 as written left installers on the old release branch
indefinitely, with every check green.

- `^{commit}` peels the annotated tag — pushing the tag object would not advance
  a branch.
- **Fast-forward only.** No `+`, no `--force`. If git refuses it as
  non-fast-forward, ancestry broke after step 2 — return to precondition A.

This push triggers the release deploy: Railway builds the release branch and runs
`npm run pg:schema` as its `preDeployCommand`, **from the deployed artifact's
tree**.

⛔ **Never run `npm run pg:schema` against prod by hand.** It loads from *your*
checkout (`loadSchema({ cwd = process.cwd() })`), and post-cutover your checkout
is routinely ahead of the tag — a manual run applies unreleased migrations to
production.

**Then verify the deploy actually happened** — webhooks were dropped twice on
2026-09-05. Use the `railway-deploy-verify` skill; do not assume.

---

## 6. Publish

```bash
gh release create "$VERSION" --title "$VERSION" --notes "<the CHANGELOG section>"
```

Skipping this is a real habit here, not a hypothetical: Releases stop at
`v0.10.0` while `v0.11.0` and `v0.12.0` exist as tags only.

---

## 7. Watch the thing that actually tests the release

The migration lane on the next pull request or branch push exercises the
previous-tag → new-tag upgrade against a real database. **It is the only evidence
an existing install can upgrade.** Read its output: on 2026-09-06 a staging
refresh proved a v0.10-era database could *not* reach current in one deploy — the
PRET-6 migration refused, correctly, and needed an intermediate step.

## 8. Close the loop

Set the release row's `Status` to `done` in `3-log/tasks.md`, `aios push`
(dry-run first), and **read the status back** — a push that reported `ok` is not
proof the row moved. Merge automation does not close workspace-pushed rows; they
resolve `linked`, not `applied`.

---

## What this skill refuses to do

- **Merge anything into the release branch.** It only fast-forwards.
- **Run `pg:schema` against production.**
- **Deploy via Railway** — `railway up` / `redeploy` / `down` / `delete` are never
  run; verification is read-only.
- **Push a tag before the local B/C/D check passes**, because that step is
  irreversible.
- **Fast-forward past a red or pending gate**, even though nothing stops it.

## Failure modes this sequence exists to catch

| Failure | Caught by |
|---|---|
| Release branch diverged; no candidate can pass | precondition A |
| A back-merge squashed or rebased, so ancestry is still broken | precondition A's merge-method note |
| The reconcile PR cannot merge (no attestation) | precondition A's PR body |
| Local refs answering a different question | `origin/` everywhere + the 221-vs-6 note |
| Tagging a stale ref → red B → **burned version number** | step 2 |
| `DEFAULT_TAGS is stale` on every open PR | step 1's declare-then-cut order |
| Version bumped at one site of three | step 1 + `release-version-agreement` |
| A tag that is never actually released | step 5 existing at all |
| Unreleased migrations applied to prod by hand | step 5's ⛔ |
| A release that deployed nowhere | step 5's `railway-deploy-verify` routing |
| A release nobody can find | step 6 |
| A release nobody proved is installable | step 7 |
