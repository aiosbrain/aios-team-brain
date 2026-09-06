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
2. **Bump the version at all THREE sites**, in the same PR — `package.json` `.version`,
   `package-lock.json` `.version`, and `package-lock.json` `.packages[""].version`. Bumping only the
   first is the mistake this repo has already made: the version sat at `0.10.0` for 23 days and two
   releases' worth of work. `test/guards/release-version-agreement.test.ts` now fails the build if the
   three disagree, or if the newest **declared** tag is not `v${package.json.version}`.
3. **Move `CHANGELOG.md`'s `[Unreleased]` into a dated `## [X.Y.Z] — YYYY-MM-DD` section**, and leave
   an empty `## [Unreleased]` above it. It is the only human-readable record of what a pinned user is
   running. **A check now reads this heading** (RELPTR-2): the build fails if there is no section for
   the version being shipped, or if no `[Unreleased]` heading is left for the next cycle. It checks
   *presence*, not contents — and it ignores headings inside fenced code blocks, so an illustration
   cannot stand in for a missing section. Note what it still cannot check: whether the section is
   TRUE. Anything merged before you cut the tag ships in the release whether or not it is listed.
   (An earlier draft of this file claimed a check existed when none did; this line is accurate as of
   the guard, not aspirational.)
4. **Cut the tag on the release commit** and push it. **Pushing a tag now runs the release-candidate
   gate** (`.github/workflows/release-candidate.yml`, RELPTR-3) — `ci.yml` still fires on branches
   only, but the gate fires on `v*` and its result attaches to the tagged commit. **Watch it**: until
   the cutover it is expected to fail assertion D (the candidate is not yet reachable from the
   integration branch — constraint 8), which blocks nothing because the context is not required, but a
   failure on A, B or C means the tag itself is wrong. Do not publish past a red A/B/C. The migration lane picks the new tag up on the **next** PR or branch push, and that is the
   check that the release is installable from an existing database. For `v0.11.0` it is the largest
   step the lane has ever taken (**34 migration files touched: 29 added, 5 modified**;
   `postgres/schema.sql` +831/−14), so expect it to be slow and read its output. A `v*`-triggered
   verification workflow was named as follow-on work there; **RELPTR-3 shipped it** — see §3.1a.
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

**Nine**, each verified, each found by a review round rather than at cutover time — six from slice 1,
and 7–9 from RELPTR-3's two pre-code rounds and its code review. **This list is what was found, not a proof of
completeness.**

| # | Constraint | Where it bites |
|---|---|---|
| 1 | A fast-forward push to `main` can be **rejected by a required check the candidate cannot acquire** — but this is **one context, not ten**. **MEASURED 2026-08-26** on the real merge commit `6dfddfc7` (a push to `main`): **9 of the 10 required contexts are present**, because `ci.yml` and `nda-gate.yml` both fire on `push`. The sole exception is **`PR records a diff review`**, emitted only on `pull_request` (`.github/workflows/pr-review-gate.yml`). The cutover therefore needs that one context **relocated** to the integration branch — not a release-actor bypass that defeats the other nine. *(A dated measurement, not an invariant: if protection gains an eleventh context, re-measure rather than trusting this row.)* | live protection on `main`; check-runs on `6dfddfc7` |
| 2 | **Dependabot follows the default branch.** Three ecosystems, zero `target-branch` overrides (`.github/dependabot.yml`), so its PRs target the default; and security updates and alerts always follow the default branch, so a vulnerability introduced on the integration branch stays invisible until release. | `.github/dependabot.yml` |
| 3 | **PREPARED (RELPTR-4).** `aios-work-sync` fired on `pull_request` closed against `main` only, so merges elsewhere would have emitted nothing and **nothing would have closed a ticket**. It now fires on both `main` and `staging`, landed early because it is near-inert until contributions move. `scan-on-merge` was widened for the same reason — otherwise codebase readiness silently drops from per-merge to per-release. **The decision constraint 3 demanded is made: a ticket closes at INTEGRATION, not at release** (see §3.1b). **Still human at cutover:** nothing for this constraint. | `.github/workflows/aios-work-sync.yml` |
| 4 | **PREPARED (RELPTR-5).** A review against the release branch after contributions move carries every unreleased commit. The review gate and attestation instructions now fetch and diff the same resolved contribution base from `scripts/branches.mjs`. **Still human at cutover:** change `CONTRIBUTION_BASE` and the enumerated prose that names a branch (§3.1c); the invariant is a fresh contribution-base diff. | `CLAUDE.md` §Review gate |
| 5 | **`staging` is behind `main` and 0 ahead** (249 when slice 1 measured it; **257** on 2026-08-26 — it drifts further with every merge), and is branch-protected with its own (smaller) required set, so any strategy that gives it a new role begins with a fast-forward that protection has to be opened for. | `docs/CI-ARCHITECTURE.md` §Environments |
| 6 | **Bare `gh pr create` targets the default branch** absent a `branch.<name>.gh-merge-base` override (none is set here), and this repo's own attestation skill calls it without `--base`. Whatever the default is, tooling will follow it. | `.agents/skills/pr-review-attestation/SKILL.md` |
| 7 | **Tags are deletable and re-pointable by anyone with write access.** Measured 2026-08-26: **zero** repository rulesets, and `repos/.../tags/protection` returns 404. Nothing in the repository can defend the facts the release-candidate gate reads — delete or move `v0.12.0` and assertions A and B are reading a different world. A **ruleset on `refs/tags/v*` denying deletion and update** is required. And note the sharp edge: installing it later does **not** invalidate a green context already minted, so it must exist **before the first candidate context is issued**. | live rulesets API (empty); `tags/protection` → 404 |
| 8 | **Assertion D is false until `staging` is fast-forwarded.** The gate's fourth assertion — the candidate must be reachable from the integration branch — is what distinguishes "the release" from "some descendant of `main`". `staging` is **257 behind / 0 ahead**, so today every candidate fails D. That is correct and blocks nothing (the context is not required yet), but it means the fast-forward must happen **before the first release tag is cut**, or the first candidate reddens. | `scripts/release-candidate-guard.mjs`; live `git rev-list` |
| 9 | **`statuses: write` is a third context-forging route, and it is how `nda-gate.yml` already works.** A workflow holding it can POST a commit status with ANY context name onto ANY sha, and commit statuses share the namespace branch protection reads. So a same-repository pull request adding a `pull_request` workflow that requests `statuses: write` could mint `Release candidate gate` on a commit the gate never examined, during its own PR run — structurally identical to the `contents: write` route. Mitigations today: the repo default is `read`, and `test/guards/workflow-permissions.test.ts` fails the build on any unallowlisted `contents`/`statuses`/`checks` write grant — the exemption for `nda-gate.yml` is **conditional on it keeping a `pull_request_target`-only trigger**, so a pull request that adds `pull_request:` to that file to run its own edited copy loses the exemption and reddens. **App pinning is NOT a mitigation here, and an earlier draft of this row wrongly said it was**: `GITHUB_TOKEN` is an installation token for the repository's GitHub Actions app, so a forged status and the genuine check carry the SAME app identity. Keep the app pinning for what it does buy (a third-party app cannot satisfy the context) and re-audit these grants when the gate becomes required. | `.github/workflows/nda-gate.yml`; live protection (app-pinned contexts) |

### 3.1a The release-candidate gate, and what making it required costs

`scripts/release-candidate-guard.mjs` + `.github/workflows/release-candidate.yml` (RELPTR-3) validate a
release candidate **on the `v*` tag push** — the event that creates one — rather than on the push to
`main` that consumes it. The reason is mechanical: branch protection accepts a direct push only if the
pushed commit **already carries** its required contexts, so a workflow triggered *by* the push to
`main` runs after the commit has landed. It can alarm; it cannot gate. A tag-push run's `GITHUB_SHA`
is the peeled commit, and its check attaches to that commit — the same SHA protection evaluates when
`main` fast-forwards onto it.

Four assertions: **A** the tag is annotated and exactly `vX.Y.Z` · **B** the tagged tree's
`package.json` version matches the tag · **C** `main` is an ancestor of the tagged commit · **D** the
commit is reachable from the integration branch. A+B+C alone certify *"some descendant of `main`"*,
not *"the release"* — D is what makes it the right commit, and both pre-code reviewers built the same
attack against a version that lacked it.

**It is deliberately NOT a required context yet.** Making it required is a protection change, and §3.2
records the ordering pair the hard way. When that step is taken, it carries a consequence worth stating
in advance:

> Once `Release candidate gate` is required on `main`, **nothing that is not a tagged release can
> reach `main`** — every hotfix and every revert becomes a tagged patch release. That is option B's
> intent, not a side effect, but it changes how urgent fixes ship and should be agreed before the
> switch is thrown, not discovered during the first incident.

**Operational note:** the tag push and the fast-forward are two acts, and the check needs time. Push
the tag, wait for `Release candidate gate` to go green on that commit, *then* fast-forward `main`. A
fast-forward attempted while the context is still pending is rejected.

### 3.1b When a ticket closes, and what this repo's automation actually does

**Decision (RELPTR-4): a ticket closes when its work merges to the CONTRIBUTION BASE — not when a
release ships.** The work is done at integration; a release may be days later and batch dozens of
tickets, and between `v0.10.0` and `v0.12.0` that was 23 days and ~170 commits. Release-closes would
leave the board stale exactly when it is most useful.

**Revert and abandonment:** a ticket closed at integration **stays closed** if the release is later
reverted or never cut. That is identical to today's behaviour and is accepted — here "done" means
**integrated**, not shipped. A separate shipped/released signal is follow-on work, not part of this.

**What the automation actually does, which the PR template used to overstate:**

| the row came from | resolution | what happens |
|---|---|---|
| brain-native, in this project | `applied` | completed **and** projected to Linear automatically |
| pushed from the workspace (`3-log/tasks.md`) | `linked` | the event is recorded, the task is **deliberately left open** — completing on a team-wide match would create duplicate Linear issues. **You close it and `aios push`.** |

**Known limitation, recorded rather than discovered later:** the work-sync payload carries only
`pr.head.ref`. After the cutover the brain therefore **cannot tell which base a merge event came
from** — every event looks the same whether it landed on the contribution base or the release branch.

### 3.1c The cutover-day edits that a shared constant does NOT remove

`scripts/branches.mjs` (RELPTR-4) names the three branch roles once, so the Node and instruction
consumers move in one edit. **It is not "the cutover is one edit"**, and the difference is worth
writing down before someone plans a day around the wrong number. These remain separate, and each is a
file a human must change:

1. **`.github/dependabot.yml` `target-branch`** — YAML cannot import a module, and unlike a workflow
   `branches:` list there is no two-branch superset that is correct both before and after.
2. **Prose that NAMES a branch** rather than pointing at the module — undetectable by any guard,
   because `main` is a legitimate token everywhere.
3. **Every branch-protection change** — the release actor, making `Release candidate gate` required,
   relocating `PR records a diff review`.
4. **The `trusted-automation` environment's deployment branch policy — `main` only today — and it now
   gates all three `AIOS_*` consumers.** This entry has grown, and the earlier version of it is now
   wrong in a way worth naming: it said `aios-work-sync` and `scan-on-merge` "were deliberately
   pre-widened to both branches so cutover day would not have to remember them". The trigger lists
   still are. The **environment** is not, and after the credential-isolation fix all three workflows
   name it, so the policy is a cutover-day edit for every one of them:

   - **`pr-task-link.yml`** — the trigger list AND the policy move together. It runs on
     `pull_request_target`, so the run's ref is the pull request's target branch; once the environment
     holds the credentials a `staging`-based run would be refused a `main`-only policy and go red — on
     an advisory check that is never allowed to go red. Leaving its trigger at `[main]` instead makes
     it go **dark** for `staging` pull requests: the safer failure, still a loss nobody would notice.
     `test/guards/pr-task-link-credential-isolation.test.ts` pins that trigger to exactly `["main"]`
     so the widening has to be deliberate.
   - **`aios-work-sync.yml`** — trigger already `[main, staging]`, but it moved from `pull_request` to
     `pull_request_target` to close the credential hole (the `merged == true` gate used to live in a
     file the pull request could rewrite). Same consequence: the run's ref is the target branch, so a
     `staging` merge would be refused the environment and go red having run zero steps, and **no work
     event would post**. Loud, not silent — and inert only while nothing targets `staging`.
   - **`scan-on-merge.yml`** — trigger already `[main, staging]`, on `push`, so the run's ref is the
     pushed branch. A `staging` push would be refused the environment the same way. Nothing has pushed
     `staging` since 2026-07-25.

   So the cutover-day edit is one policy change (add `staging` to the environment's branch policy)
   plus `pr-task-link.yml`'s trigger list. Do the policy **first**: widening it is inert until a
   branch is actually used, whereas doing it late means red merge automation on the day.

   A related manual step, **not** a cutover item and **not** to be done in the pull request that
   enrolled these workflows: the three values still exist as repository-level secrets, which GitHub
   hands to every job regardless of `environment:`. Only deleting the repository copies makes the
   environment load-bearing, and that is a repository-admin action.
5. **The instruction corpus — PREPARED (RELPTR-5).** Commands resolve the contribution base;
   prose naming a branch still needs a human cutover edit: the attestation diff heading,
   branch-reconciliation's base declaration, and adversarial-build's Branch from, retarget to,
   and PR-base sites. General `gh pr create --base` policy remains a separate cutover decision.

### 3.1d Why the instruction corpus is its own slice

Repeated pre-code reviews found different missed forms, so a negative scan cannot establish
completeness. The canonical disposition is **12 canonical files: 22 path-form occurrences + 4 refspec occurrences**,
plus named comparison, branch, retarget and PR-base prose sites. Generated mirrors are regenerated
with `scripts/sync-skill-runtimes.sh`; the shipped handoff prompts live in `docs/archive/`.
The old counts were superseded, not a baseline to keep enforcing.

The PRIMARY guard is **per-site presence AND absence** in `test/guards/instruction-base.test.ts`:
it pins every instruction, including both rubric requirements and the eval fetch grading rule.
Fetch and diff must use the same resolved contribution base, from any cwd:

```bash
root="$(git rev-parse --show-toplevel)"
base="$(node "$root/scripts/branches.mjs" --print contribution)"
git -C "$root" fetch origin "$base"
git -C "$root" diff "origin/$base...HEAD"
```

The SECONDARY scan (`npm run check:instructions`) is **PARTIAL BY DESIGN**. It matches the literal
`origin/main` or `origin/staging` together with `/\bgit\s+[a-z-]+\b/` on the same line,
never the resolved base and never a loose `git` token. Its false-negatives include refspec form,
PR-base prose, and "Branch from `origin/main`", which carries no `git` token. Both success and
failure output state these blind spots; a green scan does not prove a complete corpus.
Production reads every tracked path from `git ls-files`, without root or extension restrictions;
read failures are fatal. Exclusions: `docs/design/**` and `docs/archive/**` (history), `.context/**`
(scratch), `test/guards/branch-roles.test.ts` (permanent release-ref fixture),
`test/guards/instruction-base.test.ts` (intentional literal fixtures), and `scripts/instruction-base.mjs`
(the classifier's own examples). The inventory guard independently checks exact path-set equality.

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
  - tag-ruleset: before the release-candidate context is FIRST MINTED
  - fast-forward-staging: before any candidate tag is pushed
  - work-sync-and-scan-widened: DONE (RELPTR-4), before contributions move
  - dependabot-target-branch: at the cutover, never before (it would aim at a stale branch)
```

The `workflow-on-main` pair is this repository's own scar tissue: `docs/CI-ARCHITECTURE.md` records that switching on
a required context before its workflow existed on `main` left **seven open PRs** stuck on
*"Expected — waiting for status"*.

### 3.3 In-flight pull requests

At cutover: freeze merges, snapshot every open PR's head SHA, fast-forward the integration branch to
`main` **exactly**, retarget while the two tips are equal, verify no head moved, and re-run checks
before unfreezing. Retargeting while the branches differ silently rebases review evidence onto a
different base.

---

## 3.4 Upgrading an EXISTING installation past PRET-6 — the ordered path

**A pre-flip installation can now jump to the retirement release only if BOTH hold**
(STAGINGMARK-2 changed the second one; it used to be an unconditional refusal):

1. **No permissive team remains** — unchanged, and still steps 3-4 below. This is checked *first*,
   inside the column-existence gate, and refuses before any membership is touched.
2. **The corpus has been partitioned** — at least one `project_context_memberships` row exists.
   This condition applies **only to a fleet that has content**: a fleet with no `items` at all is
   admitted regardless, because there is nothing to darken. An already-marked fleet skips both
   conditions — the function returns before either is evaluated.

- **A fleet whose content is already partitioned** — it has `project_context_memberships` rows, i.e.
  it went through the context substrate — now **materializes itself during preDeploy** and the deploy
  proceeds. There is nothing to upgrade through. This is the restored-staging and
  never-booted-but-otherwise-current case.
- **A fleet with content and NO context substrate** — the `v0.10.0` class, which predates the entire
  PRET series — still **refuses**, with a different and more specific error:

```
PRET-6 refused: this fleet has content but no context substrate — upgrade through the prior
                release so the corpus is partitioned before enforcement
```

  That refusal is deliberate and is the one that matters. Repairing group membership is **not** the
  same as repairing visibility: enforcement fails closed for an item with no context unit, and the
  only partitioner is the budgeted scheduler stage (batch 100, 30-minute interval). Letting such a
  fleet through would report a successful deploy over a corpus that is dark for many ticks.

**All three refusals fail safe** — the permissive one, the substrate one, and the reserved-slug
one: `pg:schema` aborts, Railway's preDeploy halts, and the old code keeps serving. `v0.10.0`
predates the entire PRET series, which is why `v0.11.0` exists as the step.

### The path

0. **Before cutting the tag** (maintainers): let in-flight migration jobs drain and ask open PRs to
   rebase onto the commit that declares `v0.11.0`. Declaring before cutting keeps every PR that
   *contains* the declaration green — but a PR still on an older base declares only through `v0.10.0`,
   and its migration job reads full history, so a rerun after the tag exists throws
   `DEFAULT_TAGS is stale`.

1. **Point the service at `release/v0.11.0`** and deploy it. A tag is not enough — Railway's GitHub
   source is a *connected branch*, so there is no supported, fleet-wide way to select a tag.
2. **Let it boot, and let auto-flip converge.** The marker is written by the running application
   (`instrumentation.ts`), not by a migration — applying the schema alone does **not** satisfy the
   precondition.
> **Steps 3 and 4 run against the `v0.11.0` release and its database — not after the upgrade.** The
> retirement deletes both: `set-access-enforcement` is gone from the admin CLI at HEAD, and
> `teams.access_enforcement` is dropped from the schema. Verified: the command exists at `803122ff`
> (`scripts/admin.ts:369`) and the column at `803122ff:postgres/schema.sql:162`; both are absent at
> HEAD. Running either after upgrading gives a confusing error, not a warning.

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
