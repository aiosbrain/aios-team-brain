# Cutover prep — the branch roles and the workflows that follow them (RELPTR-4)

Status: **NARROWED after four blocking design verdicts across two models.** Round 1: Codex BLOCKED,
Fable CLEAR-WITH-CONDITIONS — both on the same conceptual error. Round 2 on the rewrite: **Codex
BLOCKED, Fable BLOCKED**, again independently, and again on the same thing — **the measured-terrain
table was wrong a second time**, so a Scope derived from it would have reddened on day one against
files it never mentioned. Rather than fold a third time, the slice is **split**: the instruction-corpus
rewrite moves to **RELPTR-5**, and this slice keeps only what both reviewers said was right. Original
status line follows.

Previously: **rewritten after a pre-code design review returned BLOCKED.** Codex **BLOCKED**, Fable
**CLEAR-WITH-CONDITIONS / build differently**, and both landed on the same conceptual error: the first
draft proposed *one* declared "integration branch" reading `main` — while RELPTR-3's shipped guard
**already** declares the integration ref as `staging` (`scripts/release-candidate-guard.mjs:169`).
Those are two different concepts, they genuinely disagree before the cutover, and collapsing them
would have destroyed assertion D's meaning. This document is the fold · Owner: chetan
· Tier build-with: unit (the pure branch declarations + every guard over workflows and the active
instruction corpus) — no persistence and no HTTP surface

**Deps:** RELPTR-3 merged (`5e2fe27f`). No code dependency.

**Increment:** ONE PR = two named branch constants with one owner, `aios-work-sync` and
`scan-on-merge` widened, the operative review instruction made base-relative, and guards for each.
**No branch protection is changed, no release actor is created, `staging` is not fast-forwarded,
Dependabot is not retargeted, and no required context is added or moved.**

---

## Problem

Option B moves contributions from `main` to an integration branch. `docs/RELEASING.md` §3.1 records
**nine** constraints; several are repo-side code that breaks the moment contributions move, and **the
failure mode of each is silence, not an error**:

- **`aios-work-sync` fires on `pull_request` closed with `branches: [main]`.** The day work merges to
  `staging`, it emits nothing — **nothing closes a ticket**, and the board stops meaning anything.
- **`scan-on-merge` fires on `push: branches: [main]`.** After the cutover `main` moves only by
  release fast-forward, so codebase-readiness metrics silently drop from per-merge to per-release.
- **`git diff origin/main...HEAD` is an *operative* instruction** — the review gate quotes it,
  `code-reviewer.md` runs it, the attestation skills execute it. Once features branch elsewhere that
  diff carries **every unreleased commit**: the reviewer is handed hundreds of files and the review
  becomes worthless without ever failing.

### The conceptual error the review caught, and the model that replaces it

The first draft declared one thing called the integration branch and set it to `main`. That is wrong
in a way that matters, because **there are two branches with two different jobs**:

| name | today | at cutover | who uses it |
|---|---|---|---|
| **contribution base** | `main` | becomes `staging` | the review-diff instruction; the branch PRs target |
| **integration branch** | `staging` | `staging` (unchanged) | RELPTR-3's assertion D — *already shipped* |
| **release branch** | `main` | `main` (unchanged) | assertion C; what installers deploy |

`scripts/release-candidate-guard.mjs:169` already hardcodes `refs/remotes/origin/staging`, and its own
comment explains why: assertion D asks whether a candidate crossed integration, and pointing it at
`main` would make it answer a different question and destroy the deliberate pre-cutover red. So the
integration branch is **already `staging` and fixed**; only the *contribution base* moves.

That distinction is what makes the guards possible: a guard can pin `staging` **today**, from a
constant that is `staging` today, instead of from one that only becomes `staging` on the day.

### Measured terrain (live, read-only, 2026-08-27, against `main` `5e2fe27f`)

| fact | value | why it matters |
|---|---|---|
| `aios-work-sync` trigger | `pull_request`, `types: [closed]`, **`branches: [main]`** | nothing closes a ticket once work moves |
| `scan-on-merge` trigger | `push`, **`branches: [main]`** | readiness metrics degrade to per-release |
| `ci.yml`, `nda-gate.yml` | already `[main, staging]` | **already cutover-ready**; no change needed |
| files with the literal `origin/main...` | **14** | incl. `CLAUDE.md`, `scripts/pr-review-gate.mjs`, `.claude/agents/code-reviewer.md`, and `pr-review-attestation` across `.claude`/`.agents`/`.opencode`/`.cursor` |
| operative `origin/main` in a git command | **31 lines across 19 files** — re-measured after the terrain table was wrong TWICE | far more than the 14 first counted, and it spans `CONTRIBUTING.md`, `docs/agent-handoffs.md` (×9), `docs/TODO.md`, `test-ci-wiring-audit` and `adversarial-build` — none of which the first two drafts scoped. **This is why the corpus rewrite is now RELPTR-5.** |
| `.skill-runtimes.json` published | `connect`, `pr-review-attestation`, `railway-deploy-verify`, `setup-brain` | **`branch-reconciliation` is NOT mirrored** — the first draft said it was |
| existing sync guard | `test/guards/skill-runtime-sync.test.ts` | mirror drift is ALREADY guarded; a new criterion for it would be green-by-construction |
| hand-written runtime files | `sync-skill-runtimes.sh` leaves un-marked files alone (e.g. `.cursor/rules/codacy.mdc`) | neither generated nor sync-guarded, so the scan must cover them directly |
| `staging` | **258 behind, 0 ahead**; `main` NOT an ancestor | a stale snapshot, not yet an integration branch |
| open PRs targeting `staging` | **zero** | why widening is near-inert today — see Decision 2's caveat |

**My recommendation to the operator narrowed while scoping, and both reviewers confirmed the
narrowing was right** — `pr-review-gate` needs no code change (no `branches:` filter, so getting it off
`main`'s required set is protection *config*); Dependabot cannot retarget to a 258-behind branch today;
`gh pr create --base` has a different correct answer either side. But it also **missed** two things the
review found: `scan-on-merge`, and the second declaration in `release-candidate-guard.mjs`.

---

## Decision

**1. TWO named constants, one owner, and RELPTR-3's guard becomes a consumer.**
`scripts/branches.mjs` exports `CONTRIBUTION_BASE` (`main` today), `INTEGRATION_BRANCH` (`staging`,
fixed) and `RELEASE_BRANCH` (`main`, fixed). `scripts/release-candidate-guard.mjs` stops hardcoding
its refs and imports them — removing the undeclared second owner rather than leaving a guard blind
to it.

**The honest claim about cutover cost, restated because the first draft overclaimed it.** This does
**not** make the cutover one edit. It makes the *Node and instruction* consumers one edit. These
remain separate, enumerated, cutover-day edits, recorded in `docs/RELEASING.md` §3.2 so they cannot be
forgotten:

- `.github/dependabot.yml` `target-branch` (YAML cannot import a module, and there is no two-branch
  superset trick for Dependabot);
- any prose that *names* a branch rather than pointing at the module;
- every branch-protection change.

**2. `aios-work-sync` and `scan-on-merge` widen to both branches now.**

Widening is **near-inert today**: zero PRs target `staging`, and `aios-work-sync` is additionally
gated on `merged == true`. The caveat, which the first draft omitted: a *mistaken* merge into the
258-behind `staging` would now emit a work event where before it emitted nothing — and for a
brain-native row in the pushed project that resolves `applied`, i.e. it would complete a task and
project it to Linear for work that is not on trunk. That is an accepted, stated cost of landing early;
the alternative is doing it on cutover day, when a mistake is far more likely. `scan-on-merge` carries
no such risk — its scan is read-only and idempotent by `head_sha`.

**Constraint 3's decision, stated: a ticket closes when its work merges to the CONTRIBUTION BASE, not
when a release ships.** Reasons:

- the work is done at integration — reviewed, merged, on trunk;
- a release may be days later and batch dozens of tickets, so release-closes leaves the board stale
  exactly when it is most useful. Between `v0.10.0` and `v0.12.0` that was 23 days and ~170 commits;
- it preserves today's semantics ("merge to trunk closes") rather than inventing new machinery.

**Corrections to the first draft's supporting argument**, both from review: `work_events` does **not**
uniformly leave closing to a human — a workspace-pushed row resolves `linked` and is deliberately left
open, while a brain-native row in the pushed project resolves **`applied`** and IS completed and
projected automatically. And the payload carries only `pr.head.ref`, so **after the cutover the brain
cannot tell which base a merge event came from** — a known limitation, recorded rather than papered
over.

**Revert and abandonment policy**, which the review said was missing: a ticket closed at integration
stays closed if the release is later reverted or never cut. That is identical to today's behaviour and
is accepted — "done" means **integrated**, not shipped. A separate shipped/released signal is
explicitly out of scope and named as follow-on work.

**3. The instruction-corpus rewrite is DEFERRED to RELPTR-5, and this is a scope decision forced by
review.** Two independent BLOCKED verdicts landed on the same defect: the corpus was undercounted, so
any guard built to the stated Scope would have reddened on day one against files the Scope never
mentioned — `CONTRIBUTING.md:14` (the contributor entry point), `docs/agent-handoffs.md` (nine sites),
`docs/TODO.md`, `test-ci-wiring-audit`, `adversarial-build`. Re-measured: **31 operative lines across
19 files**, not the 14 first reported.

Two further problems make it a slice of its own rather than a fold:

- **"Operative `origin/main`" is design vocabulary, not an observable.** It *is* implementable as a
  declared heuristic — a line carrying a `git` invocation token plus the ref — which correctly
  separates `branch-reconciliation/SKILL.md:30` from `lib/graph/extraction-health.ts:297` on today's
  corpus. But the heuristic has known error bars (it false-negatives on `adversarial-build`'s
  "Branch from `origin/main`", which carries no `git` token), and a guard whose rule is not stated
  cannot be reviewed.
- **Decision 4 and criterion 13 contradicted each other**: excluding `docs/RELEASING.md`'s constraint-4
  quotation "by rewriting it into past tense" does not work, because past-tenseness is invisible to a
  regex. Either the literal goes or the path is excluded — the spec asked for both.

RELPTR-5 gets a complete per-file disposition (rewrite / exclude-as-history) decided BEFORE the guard
is written, which is the opposite order from this attempt.

**6. What this slice does NOT do**, each with its reason:

- **Any branch-protection change**, the release actor, the `refs/tags/v*` ruleset, making
  `Release candidate gate` required, relocating `PR records a diff review` — outward-facing GitHub
  configuration; human; recorded in `docs/RELEASING.md` §3.
- **The `staging` fast-forward** — constraint 8, and the act that starts the cutover.
- **Dependabot's `target-branch`** — would aim at a dead branch today.
- **`gh pr create --base`** — different correct answer either side.
- **A separate shipped/released signal** — Decision 2's revert policy names it as follow-on.

---

## Scope

**In:** `scripts/branches.mjs`; `scripts/release-candidate-guard.mjs` (consumes it);
`.github/workflows/aios-work-sync.yml`; `.github/workflows/scan-on-merge.yml`;
`.github/pull_request_template.md`; `docs/RELEASING.md` §3; unit guards for all of it.

**Deferred to RELPTR-5:** the whole instruction corpus — `CLAUDE.md` §Review gate,
`.claude/agents/code-reviewer.md`, the attestation and branch-reconciliation skills and their mirrors,
`CONTRIBUTING.md`, `docs/agent-handoffs.md`, `docs/TODO.md`, `test-ci-wiring-audit`,
`adversarial-build`, and the guard over them. Decision 3.

**Cut:** everything in Decision 6.

---

## Acceptance criteria

1. **unit** — a guard asserts each of the three branch roles is declared EXACTLY ONCE across
   `scripts/**`, so there is one owner per role and no undeclared second one. (The constants land in a
   new module, `scripts/branches.mjs`.)
2. **unit** — a guard asserts the release-candidate guard in `scripts/release-candidate-guard.mjs`
   derives its integration ref from the INTEGRATION token and its release ref from the RELEASE token
   **by name**, and contains no hardcoded `staging`/`main` ref literal.
3. **unit** — the IDENTITY PIN, which both reviewers found missing: because `RELEASE_BRANCH` and
   `CONTRIBUTION_BASE` are both `main` TODAY, wiring the release ref to the wrong one is invisible to
   any value assertion. A test stubs `CONTRIBUTION_BASE` to a sentinel and asserts the release guard's
   resolved refs are UNCHANGED — so the mistake reddens now instead of on cutover day, when assertion C
   would silently become "is `staging` an ancestor of the candidate".
4. **unit** — the release-candidate guard's behaviour is unchanged by the refactor, exercised against a
   REAL git fixture through its production defaults (not only asserted about source text): integration
   resolves to `staging`, release to `main`, and assertion C and D still consume the ref each is
   documented to consume.
5. **unit** — a guard over `.github/workflows/aios-work-sync.yml` asserts its `pull_request` `branches`
   list equals EXACTLY the contribution base and the integration branch — an exact set, not "contains
   both", since `[main, staging, "**"]` satisfies a containment check while silently widening the
   trigger to every branch.
6. **unit** — a guard over `.github/workflows/scan-on-merge.yml` asserts the same exact-set coverage
   for its `push` trigger.
7. **unit** — a guard asserts `aios-work-sync`'s job condition is exactly
   `github.event.pull_request.merged == true`, AND that no STEP inside the job carries an `if:` — a
   step-level `if: github.base_ref == 'main'` would suppress the emission while the job condition and
   the trigger list both still pass.
8. **unit** — a guard asserts `.github/pull_request_template.md` states the ACTUAL split rather than
   deleting the claim: a merge completes a task automatically only for a brain-native row in the pushed
   project (`applied`); a workspace-pushed row resolves `linked` and the human close is the only close.
   Presence-asserted, because stripping the sentence would satisfy a pure absence check.
9. **unit** — a guard asserts `docs/RELEASING.md` records (a) the ticket-closing decision with its
   revert/abandonment policy and the `pr.head.ref`-only limitation, (b) that constraint 3 is PREPARED
   with what remains human, and (c) the enumerated cutover-day edits from Decision 1 in §3.2.

## What would falsify this

- **A ticket that does not close after the cutover** — Decision 2 was wrong, or the widening was
  re-narrowed by a condition criterion 6 failed to pin.
- **A reviewer handed every unreleased commit** — that is RELPTR-5's falsifier now, not this slice's;
  if it happens before RELPTR-5 lands, the split was the wrong call.
- **Assertion C or D answering a different question after the cutover** — the refactor wired a ref to
  `CONTRIBUTION_BASE` and criterion 3's identity pin failed to catch it.
- **The guard reddening on a historical document** — the path exclusions are wrong, and the pressure
  will be to weaken the guard rather than fix the paths.
- **A cutover-day edit nobody remembered** — Decision 1's enumeration was incomplete, which is why it
  lives in the runbook rather than only here.
- **A tenth cutover constraint discovered at cutover time** — nine is what eight review rounds across
  two models have found, not a proof of completeness.
