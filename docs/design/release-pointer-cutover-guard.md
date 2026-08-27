# The release-candidate gate (RELPTR-3)

Status: **revised through TWO pre-code design rounds across two models.** Round 1: Codex **DECLINE**
(the post-push, tag-armed guard was monitoring rather than gating, and had a wrong-green path in which
its own context helped an invalid commit reach `main`) · Fable **CLEAR-WITH-CONDITIONS / build
differently**, independently finding the same forgeable-arm and event-to-SHA defects. The fold was a
rewrite: the arming flag was deleted and the trigger moved to the `v*` tag push. Round 2 on that
rewrite: Codex **BLOCKED**, Fable **CLEAR-WITH-CONDITIONS**, and both found the same over-correction —
**cutting assertion D was wrong** — plus a mutable-ref race and a context-identity hole. Everything
below is the round-2 fold · Owner: chetan
· Tier build-with: unit (the pure candidate decision + every guard over the workflow and docs) —
no persistence and no HTTP surface in this slice

**Deps:** RELPTR-2 (`v0.12.0` cut) is done. No code dependency.

**Increment:** ONE PR = a pure decision function, a workflow that runs it on `v*` tag pushes, two
repository-hygiene guards, and `docs/RELEASING.md` §3 corrections. **No branch protection is changed,
no required context is added, no release actor is created, `staging` is not fast-forwarded, nothing is
retargeted, and no GitHub Release is published.**

---

## Problem

Option B says `main` advances **only** by fast-forward to a commit already tagged on the integration
branch. `docs/RELEASING.md` §3.1 records that protection expresses *who* may push, while only a check
can express *what* may land.

**Round 1 established why the obvious guard is the wrong one.** Branch protection accepts a direct
push only if the pushed commit **already carries** its required contexts, so a workflow triggered *by*
the push to `main` runs after the commit has landed: it can alarm, it cannot gate. My first draft was
that workflow plus an arming tag, and it failed three ways — it could not gate; the arm was forgeable
(a same-repo PR can add `contents: write` and touch `refs/tags/*` **during its own PR run**) and
deletable; and it had a **wrong-green path**, attaching a green result to a candidate it never
examined, thereby *assisting* the failure.

So the gate stopped asking "is `main` still valid?" after the fact and now asks **"is THIS commit a
valid release candidate?"** on the event that produces one — the release tag push. Verified
empirically against a live repository with annotated tags: a tag-push run's `head_sha` is the
**peeled commit**, which is the same SHA protection evaluates when `main` fast-forwards onto it.

**Round 2 established what that rewrite broke.** Assertion C (`main` is an ancestor of the candidate)
proves *a fast-forward is possible* — not that this is *the intended release*. Both reviewers built
the same attack: tag any commit that descends from `main` but never crossed the integration branch and
A, B and C all pass. Fable's version is the sharper one because it needs no unusual access — open a
pull request and never merge it, let the `pull_request`-event contexts attach (including
`PR records a diff review`, which is self-attested), tag that head, and the gate greenlights a commit
that was never integrated. **That is what assertion D was for, and cutting it was an over-correction.**

My stated reason for cutting it — that D is false today and would create the red box slice 1 refused
to create — does not survive measurement. **Zero workflow runs have ever triggered on a tag ref in
this repository**, and workflows do not run retroactively, so restoring D cannot redden `v0.12.0` or
anything else that exists. It only means a release tag cut *before* the integration cutover reports
red on D — which is **true**, is not required by protection so blocks nothing, and is exactly the
ordering the program wants.

### Measured terrain (live, read-only, 2026-08-27)

| fact | value | why it matters |
|---|---|---|
| `main` protection | 10 required contexts, `enforce_admins: true`, `strict: true`, force-push off, **no** push restrictions, **no** bypass allowances | no release actor today; nobody can push to `main` |
| repository rulesets | **zero**; `tags/protection` → 404 | tags can be **deleted and re-pointed** by any write-access actor — constraint 7 |
| `staging` | 7 contexts, `strict: false`, `enforce_admins: **false**` | an admin can push directly to `staging` |
| `staging` vs `main` | **257 behind, 0 ahead**; `main` NOT an ancestor of `staging` | the cutover begins with a fast-forward; assertion D is false until it happens |
| `main` HEAD | exactly `v0.12.0` (annotated) | A, B, C hold today; D does not |
| tag-triggered runs, all time | **zero** | a new tag-triggered workflow starts clean and reddens nothing retroactively |
| default workflow token | `default_workflow_permissions: "read"` | no workflow can currently create or delete a ref |
| workflow permissions | all `contents: read`; `nda-gate.yml` adds `statuses: write`; `scan-on-merge.yml` adds `issues: read` + `pull-requests: read`; `ci.yml` and `migration-mirror-nightly.yml` declare none | read-only is **configuration, not law** — criterion 9 |
| tag corpus | MIXED: `v0.12.0` is a `tag` object, `v0.10.0` is a `commit` — verified with `git cat-file -t` | any tag check must peel, and assertion A's annotation requirement is a real tightening |

**A recorded constraint is corrected by measurement.** `docs/RELEASING.md` §3.1 constraint 1 implies
the required set broadly fails to attach on a push. Measured on the real merge commit `6dfddfc7` (a
push to `main`), **9 of the 10 required contexts are present**; the sole exception is
**`PR records a diff review`** (`pull_request`-only). The cutover needs **one context relocated**, not
a bypass defeating ten. Both reviewers reasoned from the overstated version until Codex caught it;
both then verified the correction independently. **This row is a dated measurement, not an invariant**
— criterion 11 is written accordingly.

---

## Decision

**1. There is NO arming flag, of any kind.** Not a file, not a tag. The gate asks a question that is
meaningful today and stays meaningful after the cutover, so there is no sentinel to forge (round 3 of
slice 1) and no arm to delete (round 1 of this slice). Least clever available design; that is its
virtue.

**2. The trigger is the `v*` tag push, and the job validates THE EVENT'S OWN COMMIT — bound to the
immutable SHA.** Round 2's second BLOCKER: resolving `refs/tags/<name>^{commit}` at job time is a
race, because the tag can be force-moved between the push and the read, leaving a green attached to
the original commit while the job validated a different one. The entry therefore requires

```
peel(event tag ref) === GITHUB_SHA === the commit validated
```

and **fails closed** if the ref has moved, disappeared, or disagrees. Criterion 5 pins it.

**3. The assertions:**

| # | assertion | the failure it catches |
|---|---|---|
| A | the pushed tag is **annotated** and matches `^v\d+\.\d+\.\d+$` | a lightweight or malformed release tag; both shapes exist in the corpus |
| B | the **tagged tree's** `package.json` `.version` equals the tag without its `v` | a half-cut release, or a tag placed on the wrong commit |
| C | current `main` is an **ancestor** of the tagged commit | the candidate is not a fast-forward from `main` |
| D | the tagged commit is **reachable from the integration branch** | the candidate never crossed integration — round 2's shared finding |

C is an early signal, not the enforcement: git's non-force push plus force-push-off is what makes a
fast-forward mandatory. **D is what makes it the RIGHT commit**, and A+B+C without D certify only
"some descendant of `main`".

Assertion A must derive the tag's object type from an **explicit re-fetch of the event's tag ref (or
the API)**, never from whatever `actions/checkout` left in `refs/tags/` — checkout is known to
re-fetch the triggering tag as `+<commit>:refs/tags/<tag>`, turning an annotated tag lightweight
locally, which would redden **every valid release**. Fable found this; criterion 12 pins it.

Assertion B reads the tagged tree because checkout and tag coincide only when A already holds; the
clause earns its place when a tag is moved, not on the happy path. (My first draft justified it with
the main-push event, where it is inert — both reviewers caught that independently.)

**4. Red-box behaviour, stated precisely rather than "by construction".** The workflow runs only on
`v*` tag pushes: it cannot block a merge and is not added to protection here. Two honest caveats
round 2 extracted: a `v*` tag pushed onto a commit that happens to be a PR head will **display** a red
run on that PR's checks tab (non-blocking, self-inflicted); and two `v*` tags on one commit make the
latest run win, so a junk second tag can redden a valid candidate (fail-closed, recovered by deleting
the junk tag and re-running).

**5. `contents: read` is configuration, and gets a guard.** No workflow may request `contents: write`
or `write-all`. Scope limit, stated: this covers `GITHUB_TOKEN` permissions only — credentials
supplied through secrets are outside it, and no guard here claims otherwise.

**6. The gate's context name gets a uniqueness guard.** Branch protection identifies a required check
by context name (plus optionally an app id) — **not** by the workflow file that produced it, and
GitHub warns that duplicate check names make required-check behaviour ambiguous. So another workflow
declaring a job with the same name could mint the accepted context on a commit this gate never saw.
A guard asserts no other workflow under `.github/workflows/` produces that name. Both reviewers.

**7. Tag deletion and stale greens are REAL and answered in the runbook, not by a cleverer check.**
No in-repo check can defend the facts it reads. Recorded as **cutover constraint 7** — a ruleset on
`refs/tags/v*` denying deletion and update — and, because a green minted before the ruleset exists is
**not** retroactively invalidated by installing it, the ordering pair is
`tag-ruleset: before the release-candidate context is first minted`, not merely before the actor is
granted push.

**8. Assertion D's cutover ordering is a numbered constraint, not prose.** Round 2's HIGH was that D
was deferred in a sentence while constraint 7 got a numbered constraint, an ordering pair and a
doc-guard. D is now IN the gate, and its enabling condition gets the same treatment: **constraint 8** —
`fast-forward staging before the first release tag is cut`, with the ordering pair
`fast-forward-staging: before any candidate tag is pushed`.

**9. What making this required COSTS, owned explicitly.** Once the context is required on `main`,
**nothing that is not a tagged release can reach `main`** — every hotfix and revert becomes a tagged
patch release. That is option B's intent, but it is a consequence the runbook must state at the moment
protection is changed, not discover afterwards.

**10. This slice does NOT resolve constraint 1, and says so.** It adds a correct context on the
candidate; it does not relocate `PR records a diff review`, configure the release actor, or change
protection. Measurement changed the size of that problem, not its ownership.

---

## Scope

**In:** `scripts/release-candidate-guard.mjs` (pure decision + a thin git/API-reading entry);
`.github/workflows/release-candidate.yml`; a workflow-permissions guard; a context-name uniqueness
guard; `docs/RELEASING.md` §3 corrections (constraint 1 corrected by measurement, constraints 7 and 8
added, §3.2 ordering pairs added, the cost in Decision 9 recorded); unit tests for all of it.

**Cut, each with the reason:**

- **`scripts/cutover-preflight.mjs`** — both reviewers, round 1: needs a token, its API shapes drift
  for months with nothing exercising them, and its criteria proved presentation rather than
  correctness.
- **Every repository-configuration change** — protection, the release actor, the tag ruleset, the
  relocation of `PR records a diff review`, the `staging` fast-forward. All outward-facing; all human;
  all recorded in the runbook.
- **A post-push audit on `main`** — the design round 1 declined. If it returns it returns labelled as
  incident detection, never as the gate.

---

## Acceptance criteria

1. **unit** — `releaseCandidateVerdict` in `scripts/release-candidate-guard.mjs` is a PURE function of
   (tagName, tagObjectType, taggedTreeVersion, mainIsAncestor, reachableFromIntegration) and returns
   `PASS` only when all FOUR assertions hold.
2. **unit** — `releaseCandidateVerdict` in `scripts/release-candidate-guard.mjs` returns `FAIL` naming
   the specific assertion when each one fails ALONE with the other three holding, so no assertion is
   redundant and none is satisfied by a sibling.
3. **unit** — `releaseCandidateVerdict` in `scripts/release-candidate-guard.mjs` FAILS a **lightweight**
   tag naming annotation as the reason, with fixtures for both corpus shapes, since `v0.10.0` is a
   `commit` object and `v0.12.0` is a `tag` object in this repository today.
4. **unit** — `releaseCandidateVerdict` in `scripts/release-candidate-guard.mjs` FAILS when the tagged
   tree's version disagrees with the tag name in EITHER direction, since a one-directional check
   passes the half-cut release it exists for.
5. **unit** — the entry path in `scripts/release-candidate-guard.mjs` asserts
   `peel(event tag ref) === GITHUB_SHA` and FAILS CLOSED when the ref has moved, is absent, or
   disagrees — pinned at the call site, because validating a commit other than the one the green
   attaches to is the wrong-green path that made round 1 DECLINE and round 2 BLOCK.
6. **unit** — a guard over `.github/workflows/release-candidate.yml` asserts it triggers on `push`
   with a `tags:` filter and NOT on `pull_request` or any branch push, so it cannot block a merge.
7. **unit** — a guard over `.github/workflows/release-candidate.yml` asserts the job carries no
   ref-scoping `if:` that could exclude the tag event, and requests `fetch-depth: 0`, since ancestry
   and reachability are meaningless against a shallow checkout.
8. **unit** — a guard over `.github/workflows/release-candidate.yml` asserts the job ACTUALLY INVOKES
   `scripts/release-candidate-guard.mjs` and that no step neutralises its exit status via
   `continue-on-error`, `|| true`, or a step-level `if:` — a workflow satisfying the trigger guards
   while running `echo ok` would pass criteria 6 and 7 with the tested entry point never called.
9. **unit** — a guard asserts NO workflow under `.github/workflows/` requests `contents: write` or
   `permissions: write-all`, with SEPARATE tripping fixtures for each of those two spellings (one
   condition per fixture), and the guard is proven non-vacuous by each. `nda-gate.yml`'s
   `statuses: write` is untouched by this guard because it is neither spelling — stated so the
   allowlist is not mistaken for an exemption.
10. **unit** — a guard asserts NO other workflow under `.github/workflows/` declares a job whose
    resulting check name equals the release-candidate context, closing the duplicate-context-name
    route by which a green could be minted on an unexamined commit.
11. **unit** — a guard asserts `docs/RELEASING.md` §3.1 names `PR records a diff review` as the single
    `pull_request`-only required context AND labels that count as a **dated measurement** with its
    date — so that protection gaining an eleventh context makes the doc stale-by-construction rather
    than silently false while the test stays green.
12. **unit** — the entry derives the tag's OBJECT TYPE from an explicit re-fetch of the event's tag
    ref or from the API, not from `refs/tags/` as left by checkout; asserted at the call site, because
    checkout's tag clobbering would otherwise redden every valid annotated release.
13. **unit** — a guard asserts `docs/RELEASING.md` §3.1 contains constraints **7** (the `refs/tags/v*`
    ruleset) and **8** (fast-forward `staging` before the first candidate tag), and that §3.2 carries
    both ordering pairs — including that the ruleset precedes the FIRST MINTING of the context, since
    installing it later does not invalidate greens already issued.
14. **unit** — a guard asserts `docs/RELEASING.md` records Decision 9's cost: once the context is
    required, only tagged releases can reach `main`, so hotfixes become tagged patch releases.
15. **unit** — `releaseCandidateVerdict` REJECTS a tag name that is not exactly `vX.Y.Z`; a
    pre-release (`v0.13.0-rc.1`) FAILS rather than passing. The reason is LOUDNESS, not safety — a
    skipped tag mints no context at all, which is already safe — and the sanctioned escape hatch for
    non-release tags is a **non-`v` prefix** (`cutover/*`, `rc/*`), recorded so nobody later relaxes
    the regex or adds the ref-scoping `if:` criterion 7 forbids.
16. **unit** — the entry path exits NON-ZERO on `FAIL` and ZERO on `PASS`, pinned at the call site: a
    pure function with green tests says nothing about whether anything calls it — this repository's
    own recorded lesson.

---

## What would falsify this

- **A green context on a commit the gate never examined** — Decision 2's SHA binding failed, or the
  duplicate-context-name route (Decision 6) is open.
- **A commit that never crossed integration reaching `main`** — assertion D was cut again, or
  constraint 8 was recorded and never applied.
- **Every valid release reddening on assertion A** — the tag object type was read from checkout's
  leftovers rather than a re-fetch (Decision 3, criterion 12).
- **A workflow acquiring `contents: write` without the guard reddening** — criterion 9 is vacuous and
  the tag-forging vector both reviewers found is open again.
- **A release tag deleted or re-pointed after the cutover**, or a green minted before the ruleset
  existed being trusted afterwards — constraint 7 recorded but mis-ordered.
- **The release fast-forward blocked by a context the candidate cannot acquire** — the measured
  correction was wrong, or `PR records a diff review` was never relocated.
- **A ninth cutover constraint discovered at cutover time** — eight is what four review rounds across
  two models have found, not a proof of completeness.
