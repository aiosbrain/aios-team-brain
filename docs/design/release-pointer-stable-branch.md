# The release pointer — `main` becomes the release branch (RELPTR-1)

Status: **revised through FOUR pre-code design reviews across two models.** Round 1: Codex **DECLINE**
(build option B instead) · Fable CLEAR-WITH-CONDITIONS naming the same load-bearing fact. The design
flipped from "add a `stable` branch" (option C) to "`main` becomes the release branch" (option B).
Round 2 on the reversal: Codex **BLOCKED** (7 High — the fork argument self-destructed at cutover, and
the guard as specced was unenforceable against GitHub's merge semantics) · Fable CLEAR-WITH-CONDITIONS
(finding a live CI tripwire that would freeze the repo on release day). Everything below is the fold
· Owner: chetan
· Tier build-with: unit (the pure release-pointer decision + every guard) + a `docs/RELEASING.md`
runbook for the steps that are deliberately human

**Deps:** none in code. The cutover has one human prerequisite (cut the first release); the guard is
written so that landing it early is safe.

**Increment:** ONE PR = the pure release-pointer decision, a CI job that runs it against real git
refs, `docs/RELEASING.md` (there is no release process today), and the doc corrections. **No tag is
cut, no branch is retargeted, no repo setting is changed, and no Railway setting is touched.**

## Problem

**Nothing an installed user runs is a release.** They track a branch, and that branch is trunk.

Measured 2026-08-25 against `main` @ `63e88c99`:

| | |
|---|---|
| Newest tag | **`v0.10.0`**, cut **2026-08-03** (`8fc1e1bc`) |
| Commits on `main` since it | **166** |
| Migration files since it | **29 added / 34 changed** |
| `postgres/schema.sql` since it | **+831 / −14** |
| `package.json` version | still **`0.10.0`** |
| `CHANGELOG.md` | `[Unreleased]` holds all 22 days of it |
| brain-api contract | code declares **1.23** (`lib/api/version.ts:84`); `v0.10.0` declared **1.15** |
| Documented release process | **none** — a grep for "cut a tag / release process / semver" finds only incidental hits |

Tags exist, but nothing consumes them as a *ship* mechanism. **They are not unconsumed, though — and
an earlier draft of this spec said they were, which hid a release-day merge freeze.**
`scripts/migrate-from-existing.mjs:63` hardcodes `DEFAULT_TAGS = ["v0.7.0","v0.8.0","v0.9.0","v0.10.0"]`
and `:404-410` **throws** `DEFAULT_TAGS is stale` the moment a newer `v*` tag exists that is not in the
set — deliberately ("Whenever a release is cut, add it to DEFAULT_TAGS"). That lane runs in `ci.yml`
**on every pull request** (`ci.yml:98-104`, `fetch-depth: 0` precisely so it can read tags). So
**cutting `v0.11.0` reds the migration lane on every open PR until `DEFAULT_TAGS` is extended and the
`v0.10.0 → v0.11.0` upgrade passes** — the largest step that lane has ever taken (29 added / 34 changed
migration files, `schema.sql` +831/−14). The tripwire is correct and is doing its job; the runbook has
to obey it, which is why "cut the tag" and "extend `DEFAULT_TAGS`" are ONE step in the order below.

The nightly schema-history diff (`.github/workflows/migration-mirror-nightly.yml:42`) is the other
consumer.

### What an installed user actually gets — and the premise BOTH reviews got wrong

The one-click installer (`docs/ARCHITECTURE.md:17`) does **not** fork: it deploys *our* repository on
**`main`** (`docs/RAILWAY-TEMPLATE.md:21`, `:87`; `README.md:161-162`, `:316-317`; `CHANGELOG.md:60`).

I reported, and both reviewers reasoned from, the assumption that such a service then **tracks** our
pushes. **Railway's own documentation says it cannot.** From
`docs.railway.com/deployments/github-autodeploys`, read 2026-08-25:

> **Requirements for autodeploy** — "Autodeploy works only when at least one project member has a
> connected GitHub account with **contributor access to the repository**. **Public repositories where
> no project member has contributor access cannot use autodeploy.**"

A stranger deploying our public repo has no contributor access to it. So:

> **An existing one-click install does not automatically deploy our ordinary pushes.**

**An earlier draft of this spec drew that as "a frozen snapshot… receives nothing, ever", and both
round-2 reviews refuted it.** Railway documents two paths by which an install DOES move:
**"Deploy Latest Commit"**, which re-resolves the connected branch tip on demand, and **template
updates** — *"Railway monitors the template's source repository for changes… you will receive a
notification. You can then choose to apply the update"* (`docs.railway.com/templates/updates`, read
2026-08-25). A contributor's own install can also autodeploy, since they have contributor access.

So the accurate statement is: **an install is frozen until its owner pokes it, and then it jumps to
whatever the connected branch says now.** That is *worse* for option C than "frozen" was, not better —
every future rebuild of every existing install would land on trunk. It is the argument round 1 was
reaching for, and it survives in this narrower form.

Two consequences:

1. **The ref an install resolves — at install time and at every later rebuild — is what matters.**
2. **`main` is the ref every one of them names.** That is the asymmetry the decision turns on.

### The reason the answer is B: the constraint names FORKS

The governing constraint is *"nobody who **forks** or installs AIOS should end up running staging
code."* A fork's default branch is copied from ours, and existing forks **sync from upstream `main`**.

**The strong form of this argument is refutable and both reviews said so:** under option C we could
flip the GitHub default branch to `stable` and fix every *future* fork. What survives is narrower and
still decisive:

- **Existing forks self-heal under B** — the next time one syncs `main` it receives a release. Under
  C + a default flip, a syncing fork pulls *more trunk*.
- **`scripts/setup.mjs:334-336` names `main` in prose**: *"Fork aiosbrain/aios-team-brain → Railway →
  New → GitHub Repo → your fork → **Push to main**."* Under B that instruction becomes correct; under
  C it stays wrong until edited.

**And the lesson underneath, which changed the design:** *"whatever the default branch is"* is not a
safety property — it is a GitHub setting that this very spec proposed to change. Round 2 caught the
self-contradiction: an earlier draft leaned on fork-inherits-`main` **and** scheduled a flip of the
default to `staging`, which would have destroyed the property at cutover. **Decision 7 resolves it by
not relying on defaults at all.**

## Decision

**0. THE SLICE NARROWED, after a third review round returned BLOCKED with six mechanical HIGHs.**
Rounds 1–3 kept finding that the *cutover* — not the strategy — is a coordinated operation across
GitHub protection semantics, Dependabot, work-event automation and a CI tripwire, most of it outside
this repository. Trying to specify and gate all of it in one PR is how a spec grows a section per
review round and ships none of them.

So this PR is the part that is **true today, valuable under every option, and blocking all of them**:

> **You cannot cut a release right now. `scripts/migrate-from-existing.mjs` makes it impossible
> without freezing the repo.** That is slice 1.

Everything else — the branch cutover, the release-pointer guard, the workflow, the sentinel — is
slice 2, and `docs/RELEASING.md` records what rounds 1–3 established about it so the next slice starts
from evidence instead of from scratch. **The choice of option is the operator's; this PR does not make
it.**

**1. The `DEFAULT_TAGS` deadlock is a BUG, and it is the release-blocking prerequisite.** Verified,
both halves, in `scripts/migrate-from-existing.mjs`:

- `:400` — `for (const tag of tags) if (!knownSet.has(tag)) throw new Error("unknown git tag: " + tag)`.
  So **extending the list before the tag exists throws.**
- `:402-410` — `throw new Error("DEFAULT_TAGS is stale: …")` when a newer `v*` tag exists that is not
  in the set. So **cutting the tag before extending the list throws** — on every open PR, because that
  lane runs in `ci.yml:98-104` on `pull_request`.

There is no ordering that avoids a red window. Tag first and every other open PR reds until the
extension lands; extend first and the extension's own PR reds. **The repo cannot cut `v0.11.0` today
without a repo-wide merge freeze**, and that is independent of any branch strategy.

**The fix is to permit exactly one DECLARED-BUT-ABSENT next tag.** `DEFAULT_TAGS` gains the tag being
prepared; the lane skips it with a notice while it does not yet exist, and exercises it the moment it
does. Order becomes: land the preparation PR → cut the tag → the lane upgrades through it. No window.

**Why "exactly one" and not "skip any missing tag":** the staleness check exists precisely because a
hardcoded list rots silently — its own comment says so. Permitting *any* absent tag would delete that
property. Permitting one *declared next* tag keeps it: the list still has to name the release before
it happens, and any tag that exists must be covered.

**2. Four live false claims are corrected, each found while specifying and each verified:**

| file:line | claims | actual |
|---|---|---|
| `docs/CI-ARCHITECTURE.md:198-202` | 8 required contexts, `strict: false` | **10** contexts, `strict: true` (live API, 2026-08-25) |
| `docs/OPS.md:352-353` | brain-api **v1.21** | `lib/api/version.ts:84` declares **1.23** |
| `CHANGELOG.md:5-7` | brain-api **v1.22** | same drift, second site |
| `install.sh:6-7` | the served copy "fetches a **pinned ref**" | it pins whatever `AIOS_REF` is, and the default is `main` |

The first is not incidental: `docs/CI-ARCHITECTURE.md` carries its own warning to *"Re-verify against
the API, not against this file"*, and slice 2's protection design depends on that number.

**3. `docs/RELEASING.md` records the ritual AND the six constraints slice 2 must satisfy.** Each is
verified, and each would have been discovered at cutover time otherwise:

| # | Constraint | Evidence |
|---|---|---|
| 1 | A fast-forward push to `main` can be **rejected by required checks**: `PR records a diff review` is emitted only on `pull_request` (`pr-review-gate.yml:26`), against the merge ref — not the squash SHA that lands on the integration branch. Protection needs a named release actor with a PR-requirement bypass, not a blanket one. | `.github/workflows/pr-review-gate.yml:26`; live protection: `required_pull_request_reviews: true`, `enforce_admins: true`, `allow_force_pushes: false`, `strict: true`, 10 contexts |
| 2 | **Dependabot targets the default branch and has no `target-branch`** — 3 ecosystems, 0 overrides — so its PRs would be refused by a "no PRs to `main`" rule; and security updates and alerts always follow the *default* branch, so a vulnerability introduced on an integration branch stays invisible until release. | `.github/dependabot.yml` (3 ecosystems, 0 `target-branch`) |
| 3 | **`aios-work-sync` breaks the day contributions move**, and is not deferrable: it fires on `pull_request` closed against `main` (`:3-13`), so feature merges elsewhere emit nothing — and a release delivered by direct push emits nothing either. Nothing would close a ticket. | `.github/workflows/aios-work-sync.yml:3-13` |
| 4 | **`git diff origin/main...HEAD` is the operative review instruction** (`CLAUDE.md:104`, the `pr-review-attestation` skills). The moment features branch elsewhere, that diff carries every unreleased commit. Active instructions cannot be updated after the fact. | `CLAUDE.md:104` |
| 5 | **`staging` is 249 behind / 0 ahead of `main`** and is branch-protected (7 contexts), so any strategy that gives it a new role starts with a fast-forward that protection must be opened for. | live `git rev-list`, live protection API |
| 6 | **Bare `gh pr create` targets the default branch**, and this repo's own attestation skill calls it without `--base`. | `.agents/skills/pr-review-attestation/SKILL.md` |

**4. What this PR deliberately does NOT do.** It does not create a branch, cut a tag, change a repo
setting, touch Railway, or move any contribution flow. It does not ship the release-pointer guard: that
guard's invariant (`main`'s HEAD is always a tagged release) is **false today by design**, and shipping
a check whose precondition does not exist is how a repo learns to ignore a red box. It ships in slice 2,
with the cutover that makes it true.

## Scope

**In:** the `DEFAULT_TAGS` next-tag fix in `scripts/migrate-from-existing.mjs` (pure decision +
unit tests); `docs/RELEASING.md`; the four corrections above; and `docs/ARCHITECTURE.md`'s
"Changing X?" pointer to the release process.

**Cut, each with the reason:**
- **The branch cutover and the strategy switch** — the operator's decision, and a coordinated
  multi-system operation. `docs/RELEASING.md` §Cutover records the six constraints; slice 2 executes it.
- **The release-pointer guard, its workflow and the sentinel** — see Decision 4. Also: round 3 showed
  the sentinel as specified was a reusable self-exemption (a normal PR could flip `cutover: done` back
  to `pending`, and code-owner review is off), and that tag-event and push-event semantics differ.
  Both need the cutover's protection design to exist first.
- **Extending `DEFAULT_TAGS` with `v0.11.0` itself** — that is the release preparation, not the fix
  that makes it possible.
- **`aios-work-sync`, Dependabot and the agent-instruction corpus** — named as constraints 2/3/4/6
  with owners, not edited here: each is only correct *at* the cutover.

## Acceptance criteria

1. **unit** — `nextTagPolicy` (pure, in `scripts/migrate-from-existing.mjs`) ALLOWS exactly one declared
   tag that does not yet exist, returning it as skipped-with-notice rather than throwing.
2. **unit** — it still THROWS `unknown git tag` for a declared-but-absent tag that is NOT the newest
   declared one, so the fix cannot be used to hide a typo in the middle of the list.
3. **unit** — it still THROWS `DEFAULT_TAGS is stale` when a tag EXISTS that is newer than every
   declared tag, preserving the anti-rot property the file was built for.
4. **unit** — the stale check is proven NON-VACUOUS against the repo's real tag corpus: with
   `DEFAULT_TAGS` as shipped and the real tags, it passes; add a fictional newer tag and it throws.
5. **unit** — each of those three outcomes is asserted to occur ALONE for an input that triggers only it.
6. **unit** — the policy PEELS annotated tags, proven against the real mixed corpus (`v0.9.0` annotated,
   `v0.10.0` lightweight), because a comparison against raw tag-ref SHAs would miss half of them.
7. **unit** — a guard asserts `ci.yml` still runs the migration lane with `fetch-depth: 0`, since the
   policy is meaningless against a tagless shallow checkout.
8. **unit** — `docs/RELEASING.md` exists and its six cutover constraints each name a file the guard can
   resolve, so a constraint cannot rot into prose that points at nothing.
9. **unit** — the four corrected claims are pinned: no doc asserts a brain-api version other than
   `lib/api/version.ts`'s, and `install.sh` no longer claims the served copy pins a ref.

## What would falsify this

- **A release-day merge freeze** after this ships — the deadlock fix did not work, or the runbook's
  order was not followed.
- **A typo'd tag name silently skipped** — criterion 2's boundary was wrong and the fix widened into
  the hole the staleness check exists to close.
- **`DEFAULT_TAGS` going stale unnoticed** — criterion 3 regressed and the anti-rot property is gone.
- **Slice 2 discovering a seventh constraint at cutover time** — the six recorded here were found by
  three review rounds; the list is what was found, not a proof of completeness, and
  `docs/RELEASING.md` says so.
- **The operator choosing option C after all** — this slice is deliberately strategy-agnostic, so
  nothing here would need reversing; if that turns out to be false, the narrowing failed.
