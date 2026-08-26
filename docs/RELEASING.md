# Releasing AIOS Team Brain

**Status: there is no release process yet, and this file is the first half of building one.**

What exists today: four tags (`v0.7.0` … `v0.10.0`), the newest cut **2026-08-03**, with `main`
**166 commits and 34 migration files (29 added, 5 modified)** past it and `package.json` still reading
`0.10.0` — measured 2026-08-25 at `63e88c99`, and already moving. What does
not exist: any documented ritual, any branch that means "the current release", and — until the change
that ships alongside this file — **the ability to cut a tag at all without freezing the repository**.

Design and the evidence behind every claim here: [`design/release-pointer-stable-branch.md`](design/release-pointer-stable-branch.md) (RELPTR-1).

---

## 1. Why an install today is not running a release

The one-click installer does **not** fork. It deploys *our* repository, on **`main`**
([`RAILWAY-TEMPLATE.md`](RAILWAY-TEMPLATE.md) §Services). So whatever `main` happens to be at the
moment someone installs is what they run.

They do not then track us: Railway's autodeploy *"works only when at least one project member has a
connected GitHub account with contributor access to the repository. Public repositories where no
project member has contributor access cannot use autodeploy"* — and a stranger has none. But they are
not frozen either: **"Deploy Latest Commit" re-resolves the connected branch tip**, and template
updates are offered and can be applied. So an install sits still until its owner pokes it, and then
jumps to whatever that branch says *now*.

**That is the whole problem in one sentence:** the branch an installer names decides what a stranger
runs, today and at every future rebuild — and that branch is trunk.

---

## 2. Cutting a release

> **Do not cut a tag until the `nextTagPolicy` change is on `main`** (`scripts/migrate-from-existing.mjs`).
> Before it, cutting one throws `DEFAULT_TAGS is stale` on **every open pull request**, because the
> migration lane runs in `ci.yml` on `pull_request`. See §4.

1. **Declare the release before you cut it.** Add the new tag to `DEFAULT_TAGS` in
   `scripts/migrate-from-existing.mjs` and land that PR. The lane skips a declared-but-uncut tag with
   a notice, so this is green *before* the tag exists — that is exactly what the change bought.
2. **Bump `package.json`'s `version`** to the release version, in the same PR.
3. **Move `CHANGELOG.md`'s `[Unreleased]` into a dated `## [X.Y.Z] — YYYY-MM-DD` section.** It is the
   only human-readable record of what a pinned user is running. **No automated check reads this
   heading today** — an earlier draft of this file claimed one did, which is exactly the kind of
   invented-check claim the rest of this PR corrects.
4. **Cut the tag on the release commit** and push it. **Pushing a tag triggers nothing** —
   `ci.yml` fires on `pull_request` and `push` to branches only, so there is no tag-triggered run to
   watch. The migration lane picks the new tag up on the **next** PR or branch push, and that is the
   check that the release is installable from an existing database. For `v0.11.0` it is the largest
   step the lane has ever taken (**34 migration files touched: 29 added, 5 modified**;
   `postgres/schema.sql` +831/−14), so expect it to be slow and read its output. A `v*`-triggered
   verification workflow would close that gap and is named as follow-on work, not shipped here.
5. **Publish the GitHub Release** from the tag, with the CHANGELOG section as its body.

**Roll forward, never back.** At least one shipped migration is explicitly one-way —
`postgres/migrations/20260819180000_task_status_in_review.sql` adds an enum value and says so: *"ONE-WAY.
Postgres cannot drop an enum value. Rolling the CODE back … Roll forward."* A release is not a
checkpoint you can return to once its migrations have run.

---

## 3. The cutover that has not happened yet

The repository still deploys trunk to production and still hands trunk to installers. Fixing that
means choosing a branch model and executing a coordinated cutover. **The design work is done and
recorded** in `design/release-pointer-stable-branch.md`; the decision and the execution are not.

The recommendation there is **option B — `main` becomes the release branch, `staging` becomes the
integration branch** — because every artefact that names a branch today already names `main`: the
Railway template, the website installer bootstrap, `install.sh`, our own production service, and every
fork's default branch. Under B they all become correct with no external change, and the drift
direction is safe: forget a step and installers get a *stale but real release*. Under a new-branch
scheme, one un-repointed artefact keeps serving trunk — the original defect, silently restored.

### 3.1 The constraints the cutover must satisfy

Six, each verified, each found by a review round rather than at cutover time. **This list is what was
found, not a proof of completeness.**

| # | Constraint | Where it bites |
|---|---|---|
| 1 | A fast-forward push to `main` can be **rejected by required checks**. `PR records a diff review` is emitted only on `pull_request` (`.github/workflows/pr-review-gate.yml`), against the merge ref — not the squash commit that lands on the integration branch. Protection needs a *named release actor* with a PR-requirement bypass, not a blanket one. | live protection on `main`: PR reviews required, `enforce_admins: true`, force-pushes off, `strict: true`, 10 required contexts |
| 2 | **Dependabot follows the default branch.** Three ecosystems, zero `target-branch` overrides (`.github/dependabot.yml`), so its PRs target the default; and security updates and alerts always follow the default branch, so a vulnerability introduced on the integration branch stays invisible until release. | `.github/dependabot.yml` |
| 3 | **`aios-work-sync` breaks the day contributions move**, and cannot be deferred: it fires on a `pull_request` closed against `main` (`.github/workflows/aios-work-sync.yml`), so merges elsewhere emit nothing — and a release delivered by direct push emits nothing either. Decide whether *integration* or *release* closes a ticket before the first merge lands elsewhere. | `.github/workflows/aios-work-sync.yml` |
| 4 | **`git diff origin/main...HEAD` is an operative instruction**, not documentation — the review gate and the attestation skills run it. The moment features branch elsewhere, that diff carries every unreleased commit. It must be updated *at* the cutover, not after. | `CLAUDE.md` §Review gate |
| 5 | **`staging` is 249 commits behind `main` and 0 ahead**, and is branch-protected with its own (smaller) required set, so any strategy that gives it a new role begins with a fast-forward that protection has to be opened for. | `docs/CI-ARCHITECTURE.md` §Environments |
| 6 | **Bare `gh pr create` targets the default branch** absent a `branch.<name>.gh-merge-base` override (none is set here), and this repo's own attestation skill calls it without `--base`. Whatever the default is, tooling will follow it. | `.agents/skills/pr-review-attestation/SKILL.md` |

### 3.2 Ordering pairs that encode a hazard

Not a total order — these are the adjacencies where getting it backwards causes the incident:

```yaml
cutover: pending
order:
  - fast-forward-staging: before retargeting any contribution flow
  - declare-tag-in-DEFAULT_TAGS: before cutting the tag
  - release-actor-protection: before the first fast-forward push to main
  - candidate-checks-green: before the fast-forward push
  - agent-instructions-and-coderabbit-and-dependabot: before contributions reopen
  - work-sync-decision: before the first merge to the integration branch
  - workflow-on-main: before any new context is made required
```

The last pair is this repository's own scar tissue: `docs/CI-ARCHITECTURE.md` records that switching on
a required context before its workflow existed on `main` left **seven open PRs** stuck on
*"Expected — waiting for status"*.

### 3.3 In-flight pull requests

At cutover: freeze merges, snapshot every open PR's head SHA, fast-forward the integration branch to
`main` **exactly**, retarget while the two tips are equal, verify no head moved, and re-run checks
before unfreezing. Retargeting while the branches differ silently rebases review evidence onto a
different base.

---

## 3.4 Upgrading an EXISTING installation past PRET-6 — the ordered path

**A pre-flip installation cannot jump to the retirement release.**
`postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql` refuses:

```
PRET-6 refused: the PRET-4 builtin materialization has not completed on this fleet
                — upgrade through the prior release first
```

That refusal is correct and fails safe — `pg:schema` aborts, Railway's preDeploy halts, and the old
code keeps serving. But until `v0.11.0` exists there was **no release to upgrade through**: `v0.10.0`
predates the entire PRET series.

### The path

1. **Point the service at `release/v0.11.0`** and deploy it. A tag is not enough — Railway's GitHub
   source is a *connected branch*, so there is no supported, fleet-wide way to select a tag.
2. **Let it boot, and let auto-flip converge.** The marker is written by the running application
   (`instrumentation.ts`), not by a migration — applying the schema alone does **not** satisfy the
   precondition.
3. **Flip any team auto-flip could not**, using the command that release carries:

   ```bash
   npm run admin -- set-access-enforcement <team-slug> enforcing
   ```

4. **Verify both preconditions directly. This query is the gate — not a log line:**

   ```sql
   select exists (select 1 from migration_markers where name = 'pret4_builtin_materialize') as marker_ok,
          (select count(*) from teams where access_enforcement = 'permissive') as permissive_left;
   ```

   Proceed only on `marker_ok = t` **and** `permissive_left = 0`.

   Why a query rather than the boot log: the boot materialization is best-effort and its retry lives in
   the scheduler, which `instrumentation.ts` starts **only when `INGEST_POLL_ENABLED !== "false"`**. A
   transient boot failure on a service with ingestion disabled leaves a healthy-looking instance with
   no marker — and the next upgrade refuses exactly as before.

5. **Point the service back at `main`** and deploy the retirement release.

Full detail, including what auto-flip will and will not do for you: `RELEASE-NOTES-pret6.md`.

---

## 4. The deadlock this file ships with the fix for

`scripts/migrate-from-existing.mjs` enforced two rules back to back:

- every declared tag must exist → **extend the list first and the extension's own PR throws**
  `unknown git tag`;
- the newest existing tag must be declared → **cut the tag first and every open PR throws**
  `DEFAULT_TAGS is stale`.

No ordering avoided a red window, so the repository could not cut `v0.11.0` without a merge freeze —
regardless of branch strategy. `nextTagPolicy` widens the first rule by **exactly one tag**: the
newest *declared* release may be absent, because that is a release being prepared — **and only when the
list comes from `DEFAULT_TAGS`**, never from an operator's `--tags`, so a typo on the command line is
still rejected rather than silently skipped.

Two limits worth stating rather than discovering, both found in review:

- The staleness rule checks only the **newest** existing release, so a tag that exists in the middle of
  the range and is not declared still passes. "Any tag that exists must be declared" would be too strong.
- A **deleted** newest tag is indistinguishable from one not yet cut, so it reports as pending rather
  than throwing. Accepted: deleting a release tag is not a thing the ritual does, and no in-repo signal
  separates the two states.

That rule is not a nuisance. Its own comment explains it: a hardcoded list *"rots SILENTLY — the lane
would keep upgrading from an ever-staler state and stay green, which is the exact failure shape this
file exists to remove."*
