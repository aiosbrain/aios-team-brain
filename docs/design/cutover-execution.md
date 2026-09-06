# The cutover, executed — `staging` becomes the contribution base (RELPTR-6)

Status: **round 1 BLOCKED by Codex (gpt-5.6-sol), 2026-09-05 — folded into a SPLIT.** The reviewer's
ruling: the value-invariant guard hardening is sound and should merge now; the branch flip, the
Dependabot retarget and the `pr-task-link` trigger must NOT sit in a mergeable precursor, because the
runbook's ordering pairs (`dependabot-target-branch: at the cutover, never before`) and the
`pr-task-link` header's own argument both forbid it. Round 2 ran: Fable reviewed the DIFF
(CLEAR-WITH-CONDITIONS), gpt-6-astra reviewed it cold (BLOCKED — it caught a false premise in Fable's
own refutation), and Fable re-cleared the post-fold diff (CLEAR-WITH-CONDITIONS, prose only). PR A's
criteria (2–6, 15) are folded and satisfied. **The HELD set's criteria — 1, 7–14, 16 — remain in their
round-1 form and still carry the open findings listed at the end of this document; they are not
review-clean and must not be treated as such when the cutover PR is written.** Owner: chetan
· Tier build-with: **unit** (`test/guards/branch-roles.test.ts`, `test/guards/instruction-base.test.ts`,
`test/guards/pr-task-link-credential-isolation.test.ts`) — no persistence, no HTTP, no model.

**Deps:** RELPTR-4 (`1633e438`, `scripts/branches.mjs`) and RELPTR-5 (`c76e66af`, the instruction
corpus resolves the base) are both merged. `staging` was fast-forwarded to `c76e66af` on 2026-09-05
(see Measured terrain), which is the §3.2 pair `fast-forward-staging: before retargeting any
contribution flow`.

**Increment — SPLIT after review, two change sets, not one:**

- **PR A (mergeable now):** the three value-invariant guard fixes, D1/D2/D3 below. No branch flip, no
  Dependabot edit, no workflow trigger edit, no cutover-status prose. Every fix is correct **today**
  and each is a latent defect that only surfaces on cutover day, so leaving it in an unmerged branch
  means the repository does not have the fix.
- **The cutover change set (held for the coordinated window):** the `CONTRIBUTION_BASE` flip, the
  instruction prose + regenerated mirrors, the Dependabot `target-branch` overrides and the
  `pr-task-link` trigger — applied **alongside** the verified environment-policy and branch-protection
  changes, with the Railway staging prerequisite verified before contributions reopen.

Every branch protection change, the `trusted-automation` environment branch policy, the tag ruleset,
the release actor and the GitHub default branch are **human admin steps and are in neither PR**.

---

## Problem

`docs/RELEASING.md` §3 records a cutover that has been designed, prepared across four slices, and
never executed. RELPTR-4 made the Node consumers follow a single declared role; RELPTR-5 made the
instruction corpus resolve that role at run time. What remains in code is the one-line flip plus the
sites that a shared constant provably does **not** cover — §3.1c enumerates them, and this slice is
the enumeration turned into a diff.

The slice exists as its own row because the flip is **not** safe to write casually: today
`RELEASE_BRANCH === CONTRIBUTION_BASE === "main"`, so several assertions that look like they pin a
value are today satisfied by *either* role, and moving the contribution base is the event that tells
them apart. Three of those are latent defects this slice found by reading, not by running.

---

## Measured terrain — live, 2026-09-05

Everything below was read from the live GitHub API, the live Railway project, and the repository at
`c76e66af`. Nothing here is inferred.

| fact | measurement |
|---|---|
| `staging` before | `05a771ff` (2026-07-25), **0 ahead / 267 behind** `main` |
| `staging` after | fast-forwarded to `c76e66af`; **0 ahead / 0 behind** — constraints 5 and 8 now hold |
| the push | required an **admin bypass** (`staging` requires a pull request at 0 approvals); `enforce_admins: false` on `staging` made that possible |
| `scan-on-merge` on that push | **red in 3s having run ZERO steps** — the `trusted-automation` environment's branch policy is `main` only |
| `trusted-automation` policy | exactly one branch policy: `main` (API-confirmed) |
| repository rulesets | **zero**; `repos/.../tags/protection` → **404** (constraint 7 still false) |
| `main` protection | 10 required contexts, `enforce_admins: true`, `strict: true`, **no push restrictions** — so no actor can push to `main` at all (constraint 1/the release actor: still false) |
| `staging` protection | 7 required contexts, **no** `PR records a diff review`, push restricted to `chetan-guevara` + `johnellison`, `enforce_admins: false` |
| `.github/dependabot.yml` | 3 ecosystems (npm, pip, github-actions), **zero** `target-branch` overrides |
| `.github/workflows/pr-task-link.yml` | `on.pull_request_target.branches: [main]`; guard pins it to exactly `["main"]` |
| `.github/workflows/aios-work-sync.yml` / `.github/workflows/scan-on-merge.yml` | already `[main, staging]` |
| Railway staging | **did not auto-deploy** the fast-forward; latest deployment still 2026-07-25 08:36. Staging Postgres carries the July-25 schema (**70** tables vs `main`'s **85**; `members.handle` absent) |

**What is NOT measured:** whether Railway's staging service has a GitHub source connected at all, or
whether the webhook was merely dropped. Distinguishing those needs the Railway dashboard, which is a
human read; the CLI is read-only here and cannot show service source settings.

---

## The three latent defects the flip exposes

These are the reason this is a spec and not a one-line commit. Each is green today and each fails —
or worse, silently stops testing anything — the moment `CONTRIBUTION_BASE` moves.

### D1 — the workflow triggers are wired to the wrong role, invisibly

`test/guards/branch-roles.test.ts:228,239` assert:

```ts
expect(on.pull_request_target!.branches).toEqual([CONTRIBUTION_BASE, INTEGRATION_BRANCH]);
expect((on.push as { branches?: string[] }).branches).toEqual([CONTRIBUTION_BASE, INTEGRATION_BRANCH]);
```

Today that evaluates to `["main", "staging"]` and matches both files. After the flip it evaluates to
`["staging", "staging"]` and the guard goes **red against a correct file**.

The correct role pair is `[RELEASE_BRANCH, INTEGRATION_BRANCH]`.

**REFUTED, and the refutation is recorded rather than quietly dropped:** a first draft of this spec
justified keeping `main` by claiming that dropping it would reduce codebase readiness to per-release.
Codex disproved that — post-cutover every merge lands on `staging`, so `staging`-only scanning is
still per-merge. RELPTR-4's original failure was the mirror image (a `main`-ONLY trigger after
contributions moved), and reversing it is not an argument for this pair.

The real justifications differ per workflow and must be stated separately rather than under one slogan:

- **`scan-on-merge` (push):** keeping `main` buys release-time retry/reconciliation, at the cost of
  normally re-scanning a SHA already scanned on `staging`. Storage is keyed by `head_sha`, so the
  open question — no-op or duplicate compute — must be answered and tested, not assumed.
- **`aios-work-sync` (`pull_request_target: closed`):** a release fast-forward to `main` emits no
  `pull_request_target` event at all, so `main`'s entry serves in-flight and exceptional pull requests
  into the release branch.

  **REFUTED by Fable's diff review, recorded rather than deleted:** a draft called this pair a
  *security allowlist of trusted PR bases*. It is not one. On `pull_request_target` the workflow file
  — `on:` filter included — is read from the pull request's BASE branch, and a same-repo collaborator
  can push a branch and control that copy, which is exactly the population the workflow's own header
  names as the threat. The real blast-radius control is the `trusted-automation` environment's
  deployment branch policy, which lives in repository settings, not in the file.

  **What actually justifies the pair, in both workflows, is elimination:** the trigger needs two
  DISTINCT branches. `[CONTRIBUTION_BASE, RELEASE_BRANCH]` collapses today (both `main`);
  `[CONTRIBUTION_BASE, INTEGRATION_BRANCH]` collapses after the cutover (both `staging`);
  `[RELEASE_BRANCH, INTEGRATION_BRANCH]` is distinct in both worlds. That is checkable, and it is
  what the guard now asserts.

**This correction is value-invariant today** (`RELEASE_BRANCH === CONTRIBUTION_BASE === "main"`), so
it can be verified before the flip and carries no behavioural risk. It is the identity trap the
`scripts/branches.mjs` header warns about, found in a second place.

### D2 — the identity pin's stub is keyed on the literal being replaced

`test/guards/branch-roles.test.ts:106` builds its sentinel by string-replacing
`'export const CONTRIBUTION_BASE = "main";'`. After the flip that literal no longer exists.

This one fails **loudly** — line 107's `expect(branches, "the stub must apply").not.toBe(src)` catches
it — so it is a maintenance defect, not a silent one. It is listed because the fix must not be "update
the literal to `staging`", which would reintroduce the same coupling one cutover later.

### D3 — the instruction-base sentinel stops being a sentinel (silent)

`test/guards/instruction-base.test.ts:182` writes a scratch module:

```ts
writeFileSync(join(dir, "branches.mjs"), 'export const CONTRIBUTION_BASE = "staging"; export const RELEASE_BRANCH = "release-sentinel";');
```

`"staging"` is chosen precisely because it is **not** the real value — that is what makes the test
prove the instruction resolves the base rather than hardcoding it. After the flip, `"staging"` **is**
the real value, and the test can no longer distinguish "resolved the base" from "hardcoded `staging`".
It stays green while proving nothing.

This is the dangerous one: no assertion reddens, so nothing announces the loss. It is the
[measured-one-state-claimed-an-invariant] shape — a fixture whose discriminating power depends on a
value that this very PR changes.

---

## Decisions

**Decision 1 — the flip is one line, and the roles absorb the rest.**
`CONTRIBUTION_BASE = "staging"` in `scripts/branches.mjs`. Every Node consumer
(`scripts/pr-review-gate.mjs`) and every instruction site (RELPTR-5's 22 path + 4 refspec
occurrences) follows without further edits. `INTEGRATION_BRANCH` and `RELEASE_BRANCH` do not move.

**Decision 2 — express "both live branches" as `[RELEASE_BRANCH, INTEGRATION_BRANCH]`, not
`[CONTRIBUTION_BASE, INTEGRATION_BRANCH]`.** See D1. Post-cutover the two live branches are the
release branch and the integration branch; the contribution base is one of them, not a third thing.

**Decision 3 — sentinels must not be real branch names.** D2 and D3 both come from fixtures keyed on
a real value. Both become sentinels that no role can ever equal (`contribution-sentinel` and
`release-sentinel` — an earlier draft of this line said `__NOT-A-BRANCH__`, which is not what shipped), and the stub is
applied by a regex over the declaration rather than an exact-literal replace.

**Decision 4 — SUPERSEDED BY REVIEW. `.github/workflows/pr-task-link.yml` stays at `[main]`, and its guard keeps the
exact `["main"]` pin, until the environment policy is observably widened.** The original decision
widened the trigger and relied on a PR-body precondition to stop an early merge; the reviewer's
objection is that a stated precondition is not enforcement. **The conclusion stands; the SCENARIO
that was given for it does not, and the correction changes the cutover ordering.**

The scenario said: merge the widening while the policy is `main`-only → a pull request targeting
`staging` runs `pr-task-link` → the environment refuses it with zero steps → an advisory check goes
red. gpt-6-astra's cold review found this rests on **pre-2025-12-08 `pull_request_target` semantics**,
and the primary source confirms it — GitHub's 2025-11-07 changelog, effective **2025-12-08**: *"The
workflow file and checkout commit will always be taken from the repository's default branch,
regardless of the pull request's base branch"*, and *"For `pull_request_target`, environment rules
evaluate against the default branch."*

**So, with the default branch still `main`:** a pull request based on `staging` evaluates the
environment against `main`, the `main`-only policy ALLOWS it, and nothing goes red. Widening the
trigger early is not the hazard that was claimed.

**The real hazard moves to the DEFAULT-BRANCH MOVE, and it is bigger.** Once the default branch
becomes `staging`, every `pull_request_target` workflow — `.github/workflows/pr-task-link.yml` AND `.github/workflows/aios-work-sync.yml`
— evaluates the `trusted-automation` policy against `staging`. A `main`-only policy then refuses
**all of them**, so the advisory check goes red on every pull request and no work event posts on any
merge. The ordering pair is therefore **widen the environment policy BEFORE moving the default
branch**, not before widening a trigger.

**What is unaffected:** the `scan-on-merge` failure measured on 2026-09-05 was a **`push`** event,
whose `GITHUB_REF` is the pushed branch. That evaluated against `staging`, was refused, and ran zero
steps. That measurement stands and is untouched by the `pull_request_target` change.

The edit still moves into the cutover change set — a trigger widening with no branch to serve is
churn, and it belongs with the policy and default-branch changes it is ordered against. Original
reasoning follows, and is superseded by the paragraphs above. §3.1c is explicit: the environment's branch policy must be widened
**first**. Widening the trigger while the policy is `main`-only makes a `staging` pull request's run
get refused the environment and go red — on a check whose whole contract is that it never goes red.
`continue-on-error: true` masks it, which the file's own header calls out as *"relying on this line to
hide a broken job, which is not what it is for"*. The PR therefore lands the widening but the merge is
gated on the policy change, and this is written into the PR body as a merge precondition.

**Decision 5 — the prose parentheticals flip, the mirrors are regenerated, never hand-edited.**
Six canonical files carry `the contribution base (currently \`main\`, declared in
\`scripts/branches.mjs\`)`; `.claude/skills/adversarial-build-astra/SKILL.md` carries a `today \`main\``
variant. All become `staging`. `.agents/`, `.opencode/` and `.cursor/` copies are regenerated with
`scripts/sync-skill-runtimes.sh`.

**Decision 6 — `scripts/instruction-base.mjs` does NOT change.** It matches the literals
`origin/(main|staging)` deliberately, never the resolved base, so that post-cutover it still sees a
reintroduced `origin/main` — the likeliest regression. RELPTR-5 records this as a decision; this slice
must not "fix" it into following the role.

### Open question for review — one PR or two?

D1, D2 and D3 are **correct today and value-invariant**: they can merge before the cutover and stop
being latent. The flip itself must not merge until the admin steps are done. Two shapes:

- **A (one PR, draft):** everything together, held unmerged. Simple, but it rots against a moving
  `main`, and the three hardening fixes stay latent for however long the admin steps take.
- **B (two PRs, stacked):** PR A = D1+D2+D3 hardening, mergeable immediately; PR B = the flip +
  dependabot + trigger + prose, draft. More coordination; removes the latency.

The operator asked for one PR. **Recommendation: B**, because the whole point of D3 is that it is a
guard which silently stops working, and leaving it in an unmerged branch means the repository does not
have the fix. Reviewer should rule.

---

## Scope — every file this PR may touch

| file | change |
|---|---|
| `scripts/branches.mjs` | `CONTRIBUTION_BASE` → `"staging"`; header prose updated to describe the post-cutover world |
| `test/guards/branch-roles.test.ts` | role-pair fix (D1), sentinel de-coupling (D2), value assertion `"staging"` |
| `test/guards/instruction-base.test.ts` | sentinel de-vacuity (D3), `prose` const → `currently \`staging\`` |
| `test/guards/pr-task-link-credential-isolation.test.ts` | trigger pin `["main"]` → `["main", "staging"]` |
| `.github/dependabot.yml` | `target-branch: "staging"` on all three ecosystems |
| `.github/workflows/pr-task-link.yml` | `branches: [main, staging]` + header prose corrected |
| `.github/workflows/aios-work-sync.yml`, `.github/workflows/scan-on-merge.yml` | HEADER COMMENTS ONLY — both still describe their trigger as "the contribution base and the integration branch", which reads as "staging and staging" after the flip. The guard already asserts release+integration; this is the identity trap surviving in prose. Assigned here by Fable's diff review, which found them unowned by either half |
| `.claude/skills/{adversarial-build,adversarial-build-astra,branch-reconciliation,pr-review-attestation,test-ci-wiring-audit}/**` | `currently \`main\`` → `currently \`staging\`` |
| `.agents/**`, `.opencode/**`, `.cursor/**` | REGENERATED ONLY, by `scripts/sync-skill-runtimes.sh` |
| `docs/RELEASING.md` | §3 cutover status, constraint rows 1/4/5/7/8, §3.2 ordering pairs |
| `CLAUDE.md` | **ADDED to Scope by Fable's RELPTR-7 diff review.** §6 said "Deploys happen ONLY by merging to `main`", so post-cutover an agent merging to `staging` would run the **production** schema load for code not on `main`. Out of the original fence, in-scope now: it is the file every session reads and the one stale claim with an operational blast radius |
| `docs/CI-ARCHITECTURE.md` | **ADDED to Scope by the same review** — a FIFTH carrier of the superseded `pull_request_target` model (open finding 7 said four). Three sites: the `evil2 → evil` base-branch claim, the "run's ref is the PR's target branch" cost paragraph, and `scan-on-merge`'s `main`-only note |
| `docs/design/cutover-execution.md` | this spec |

A change to any file not in this table is a finding, not a tidy-up.

---

## Acceptance criteria

**PARTITIONED BY PR — the split in the Status block reached only that block, which Fable's diff
review caught.** **PR A (the value-invariant hardening) is criteria 2, 3, 4, 5, 6 and 15.** Every
other criterion belongs to the **held cutover change set** and is not satisfiable, or even
meaningful, until `CONTRIBUTION_BASE` moves.


1. `scripts/branches.mjs` exports `CONTRIBUTION_BASE === "staging"` — asserted in unit tier `test/guards/branch-roles.test.ts`.
2. `test/guards/branch-roles.test.ts` asserts `.github/workflows/aios-work-sync.yml`'s trigger equals `[RELEASE_BRANCH, INTEGRATION_BRANCH]`, AND a source-token assertion forbids `[CONTRIBUTION_BASE, INTEGRATION_BRANCH]` while counting both surviving `RELEASE_BRANCH` sites — mutation: reverting either site must redden. **This sentence was FALSE when first written** and Fable's diff review measured it: the value assertion alone cannot see the revert, because the two pairs are the same value today, and both revert mutations SURVIVED. A source regex is evadable and is the only instrument that works here; the pin was added in the fold, and the same two mutations now REDDEN.
3. `test/guards/branch-roles.test.ts` asserts `.github/workflows/scan-on-merge.yml`'s push trigger equals `[RELEASE_BRANCH, INTEGRATION_BRANCH]` — covered by the same source-token pin as criterion 2.
4. `test/guards/branch-roles.test.ts`'s stub applies via a regex over `export const CONTRIBUTION_BASE = "<any>"`, so it survives any future value — mutation: change the declared value, the stub must still apply.
5. `test/guards/instruction-base.test.ts`'s scratch module uses a sentinel base that **no** role equals — asserted by importing all three roles and requiring the sentinel differs from each.
6. `test/guards/instruction-base.test.ts` is NON-VACUOUS: the negative control rewrites `scripts/pr-review-gate.mjs`'s `origin/${CONTRIBUTION_BASE}...HEAD` to a hardcoded `origin/main...HEAD` and asserts the rendered message loses the sentinel (executed, in-test). `origin/main` rather than `origin/staging` because it is the equivalent mutation against a sentinel base and proves the same property identically before and after the cutover — an earlier draft of this criterion named `origin/staging`, which is not what the code does.
7. `.github/dependabot.yml` sets `target-branch: "staging"` on all three ecosystems — asserted by a unit guard that parses the YAML and requires the count to equal the ecosystem count.
8. `.github/workflows/pr-task-link.yml` fires on exactly `[main, staging]` — asserted in `test/guards/pr-task-link-credential-isolation.test.ts` as an EXACT array, not containment.
9. `.github/workflows/pr-task-link.yml`'s header no longer claims the `[main]` pin is what keeps it advisory, and states the environment-policy precondition instead — presence assertion.
10. Every canonical instruction file that carried `currently \`main\`` carries `currently \`staging\`` and **no** `currently \`main\`` — per-site presence AND absence, per RELPTR-5 criterion 14.
11. `.agents/`, `.opencode/` and `.cursor/` copies match a fresh `scripts/sync-skill-runtimes.sh` run — asserted by `npm run check:skills`. This fence excludes nothing: no hand-authored content lives in those trees, and any file there that is not regenerable is an orphan the same check already reports (it did so in this worktree, for an untracked local skill stub).
12. `docs/RELEASING.md` §3.2 no longer says `cutover: pending`, and rows 5 and 8 record the fast-forward as done with its date and sha.
13. `docs/RELEASING.md` records what the fast-forward MEASURED: `scan-on-merge` red with zero steps, and Railway staging not auto-deploying — both are new facts, not predictions.
14. `npm run check:instructions` stays green and its partial-scan blind-spot message is unchanged — Decision 6.
15. `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run check:docs` all pass.
16. **(Held set only.)** The cutover PR body states the merge preconditions (environment policy widened first; default branch moved; `PR records a diff review` relocated) and is opened as a DRAFT. **PR A is deliberately NOT a draft** — it is value-invariant and meant to merge; an earlier version of this criterion applied the draft rule to both halves.

## What would falsify this design

- **(Rewritten — the original was met by this spec and left standing, which Fable's re-clear caught.)**
  It said: *if widening `pr-task-link`'s trigger before the environment policy does not produce a red
  job, Decision 4's ordering is unnecessary*, and cited the `scan-on-merge` failure as the same
  mechanism. Decision 4 now asserts that exact outcome — no red while the default branch is `main` —
  and says `scan-on-merge` was a `push`, a **different** mechanism. The live falsifier is the new
  hazard: **if, after the default branch moves to `staging` under a `main`-only `trusted-automation`
  policy, `pull_request_target` runs are NOT refused, then the widen-policy-before-default-branch
  ordering pair is unnecessary.**
- If `[RELEASE_BRANCH, INTEGRATION_BRANCH]` is the wrong pair because post-cutover `main` should stop
  receiving `scan-on-merge` entirely — that would be a product decision reversing RELPTR-4, and would
  make D1 a scope change rather than a bug fix.
- If the repository intends the default branch to stay `main` (contributions retargeted by tooling
  rather than by default), constraint 6 changes shape and Decision 1 is insufficient on its own.

## Out of scope, named

Branch protection changes of any kind · the release actor · the `refs/tags/v*` ruleset · moving the
GitHub default branch · widening the `trusted-automation` environment branch policy · making
`Release candidate gate` a required context · relocating `PR records a diff review` · re-triggering
the Railway staging deploy · anything touching the staging database.


---

## Open findings from round 1 — the criteria rewrite round 2 must clear

Recorded verbatim rather than silently folded, because every one of them is a criterion that can be
satisfied without the thing it names being true:

1. **Criterion 7 is existential in aggregate.** "target-branch count equals ecosystem count" is
   satisfied by one ecosystem carrying two keys and another carrying none. Parse every `updates`
   entry and require **exactly one** `target-branch: staging` per entry, universally.
2. **Criterion 9 has no inverse.** It requires the new prose to be present and never requires the old
   claim — that the `[main]` pin is what prevents environment refusal — to be absent.
3. **Criterion 10 is per-FILE where per-SITE is required.** Several canonical files carry more than one
   `currently \`main\`` site; a per-file existential passes after deleting one of them. Reuse RELPTR-5's
   per-site enumeration (`test/guards/instruction-base.test.ts:23`) with site-level presence AND
   old-value absence — the identical defect that BLOCKED RELPTR-5 twice.
4. **Criteria 12, 13 and 16 test documentation, not the world.** A prose edit removing `cutover:
   pending` satisfies criterion 12 while constraints 1 and 7 (release actor, tag ruleset) remain
   measurably false. Replace them with API-observable predicates: exact branch protections, exact
   environment branch policies, the default branch, the tag ruleset, the release actor's push ability,
   the required-context sets, the deployed staging SHA, and a successful pre-deploy schema hook.
5. **There is no criterion for the Railway staging runtime at all** — see below.
6. ~~**`test/guards/branch-roles.test.ts:232`'s `toContain("staging")` loses its meaning**~~ —
   **RESOLVED in PR A.** Removed; it was implied by the `toEqual` above it, and replaced by an
   assertion that the two roles in the pair can never be the same branch.

7. **FOUR files carry the superseded pre-2025-12-08 `pull_request_target` model**, not one. An
   earlier version of this finding named only the first, and Fable's re-clear enumerated the rest:
   - `docs/RELEASING.md` §3.1c (~:178–190) — argues a `staging`-based run "would be refused a
     `main`-only policy and go red": false while the default branch is `main`, and it understates
     what happens once it is not;
   - `.github/workflows/aios-work-sync.yml` (:25, :29, :46, **:69–71**, :112, :135) — the "SECOND
     COST" paragraph is now false, and it sits ten lines above the trigger this PR's new test pins;
   - `.github/workflows/pr-task-link.yml` (:28, :49, :71–75, :121, :134);
   - `test/guards/pr-task-link-credential-isolation.test.ts` (:471–472, :608) — the **assertion**
     (`["main"]`) still holds; only its stated rationale is stale.

   All four are held-set corrections, not PR A's: they are cutover-planning and rationale prose, and
   widening PR A to chase them would break its value-invariant story. Flagged so they are not
   discovered on the day.
8. **Both reviewers were wrong about this, in opposite directions, and neither could have settled it
   alone.** Fable refuted a claim using the old event model; gpt-6-astra refuted the refutation but
   had no network to check its own citation. The primary source decided it. Recorded because the
   lesson generalises: a reviewer's confident mechanism claim about a third-party platform is a
   hypothesis until the vendor's own changelog is read.

## The prerequisite this spec wrongly called out of scope

Round 1's third blocker, accepted: **the staging runtime is a cutover prerequisite, not an unrelated
operational annoyance.** The branch advanced; the service did not. The app is serving July code
against a 70-table July schema while the branch it tracks expects 85 tables. After the cutover every
merge lands on `staging` — and if its runtime neither deploys nor migrates, the integration branch has
lost the operational feedback that is the entire reason to have one. Worse, because the service's
source connection is **unmeasured**, the next merge is not evidence that deployment will recover.

Before contributions reopen, these must be observed rather than assumed:

- the staging service's source is connected to this repository and to the `staging` branch;
- a deployment of the current `staging` SHA succeeds;
- the pre-deploy schema step (`npm run pg:schema`) runs and exits zero;
- the deployed SHA equals the branch tip;
- a health check exercises the current build against the migrated staging database.

Re-triggering a deploy is a Railway **dashboard** action and stays a human step. Verifying the
resulting state is an acceptance criterion of the cutover.


---

## RELPTR-7 diff review — what Fable found, and what it changes

**Verdict: CLEAR-WITH-CONDITIONS.** All conditions folded before push. The findings worth carrying
forward, because each names a defect class rather than a typo:

1. **HIGH — an inverse guard that pinned PHRASES, not the CLAIM.** The first version forbade two exact
   strings and was green over a file that asserted the same refuted model four lines higher ("the ref
   is always the base branch"). *A guard that pins phrasing proves the text changed, not that the model
   did.* Rewritten to forbid a family of assertions across BOTH `pull_request_target` workflows — with
   a deliberate subtlety: the corrections **quote** the old claim in order to retract it, so retracted
   lines are stripped before matching, and a dedicated test proves the stripping catches an unmarked
   assertion while sparing a marked quotation.
2. **A guard nobody could keep.** The first Dependabot test asserted every `package-ecosystem` value
   was unique — a property Dependabot does not have (the same ecosystem in two directories is ordinary
   config). It would have reddened on a legitimate change, which is how a guard gets deleted rather
   than fixed. Replaced with a role-pin plus a per-entry count.
3. **The release ritual never advanced `main`.** §2 produced a tag and stopped; the fast-forward that
   makes a tag a release existed only as an aside in §3.1a. Following §2 as written would have left
   installers on the pre-cutover `main` **forever**. Now step 5, with the ordering constraint.
4. **Measured facts stated in the present tense go false silently.** Constraint rows 2/5/7/8 read as
   current state; all four had been satisfied. Marked satisfied with the date, historical measurement
   retained.
5. **The four-carrier enumeration was wrong — there were five**, and the fifth was in the file that
   documents CI itself.


## RELPTR-7 cold review (gpt-6-astra) — BLOCKED, folded

Four findings, all re-derived and all real. The two HIGHs were defects in the *folds*, which is the
class the second reviewer exists for.

1. **HIGH — the deploy fold I wrote permitted unreleased migrations against production.** `CLAUDE.md`
   said to run `npm run pg:schema` against prod after the release fast-forward. `railway.json` already
   runs it as the `preDeployCommand` **from the deployed artifact**, while a manual run reads YOUR
   checkout (`loadSchema({ cwd = process.cwd() })`). Post-cutover the local checkout is routinely AHEAD
   of the release: tag `A` ships, local `staging` is at `B`, and the manual run applies **B's
   unreleased migrations to production**. Pre-cutover this was near-safe because `main` was what you
   had just merged — *the cutover is what made the old instruction dangerous, and my fold repeated it*.
   Now: do not run it by hand; verify the release's preDeploy step instead.
2. **HIGH — the carrier sweep was incomplete and the new guard falsely certified it.** Live assertions
   survived in `pr-task-link.yml`, `aios-work-sync.yml` and `docs/CI-ARCHITECTURE.md`, and there was a
   **sixth** carrier (`.github/workflows/nda-gate.yml`) and a seventh (`docs/ARCHITECTURE.md`) where
   this spec had said four. Worse, two evasions of the guard itself: a line carrying a retraction word
   AND a live assertion was stripped whole (`# The main-only policy is obsolete; the ref is always the
   base branch.`), and the positive half was satisfied by the literal date with every explanation
   deleted. **Fixed by changing the exemption from lines to SPANS**, on a rule that is checkable:
   *history goes in quotes or parentheses; assertions do not.* Both evasions are now explicit tests.
3. **MEDIUM — Dependabot coverage could vanish while both guards passed**, because the expected count
   was derived from the same list being checked. Required (ecosystem, directory) pairs are now pinned
   explicitly; extra entries and repeated ecosystems in different directories remain legal.
4. **MEDIUM — the new identity trap, demonstrated.** `CONTRIBUTION_BASE === INTEGRATION_BRANCH ===
   "staging"`, so substituting one role for the other in the Dependabot assertions passed. A
   source-token pin now discriminates them, with the same honest caveat RELPTR-6 recorded: it is
   evadable by an equivalent spelling, and an evadable pin beats none when no value assertion can see
   the difference.

**One mutation SURVIVED and is recorded rather than hidden:** stripping three of the seven statements
of the current model from `pr-task-link.yml` leaves the guard green — because four remain. The claim
astra actually made (a bare date satisfies the positive half) is closed and unit-proven:
`CURRENT_MODEL` rejects `# 2025-12-08`, and stripping *every* statement reddens.
