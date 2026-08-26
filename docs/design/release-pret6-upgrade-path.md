# Two releases, in order — giving PRET-6 the upgrade path it requires (RELPTR-2)

Status: **rewritten after a pre-code cold read returned BLOCKED.** The first draft cut a single
`v0.11.0` from current `main`; that release **cannot be installed by any existing installation**
· Owner: chetan · Tier build-with: unit (the agreement guards) + a documented human release procedure

**Deps:** RELPTR-1 (`04682a35`, #657) is on `main`. Without it, declaring a not-yet-cut tag throws.

**Increment:** a `release/v0.11.0` branch + tag cut from the PRET-5 state, then ONE PR on `main` that
declares both tags, bumps the version, dates the changelog, and ships the agreement guards. `v0.12.0`
is tagged after that PR merges.

## Problem

### The release we were about to cut could not be installed

`postgres/migrations/20260818210000_pret6_retire_access_enforcement.sql:31-35`:

```sql
if exists (select 1 from teams)
   and not exists (select 1 from migration_markers where name = 'pret4_builtin_materialize') then
  raise exception 'PRET-6 refused: the PRET-4 builtin materialization has not completed on this fleet
                   — upgrade through the prior release first (see docs/RELEASE-NOTES-pret6.md)';
```

And `docs/RELEASE-NOTES-pret6.md:9`: *"You **may not** jump to this release from a pre-flip
installation."* The required order is: run the PRIOR release (the PRET-2..5 series), let auto-flip
converge, flip any remaining permissive team, then upgrade.

**That prior release was never tagged.** Measured: `v0.10.0` was cut **2026-08-03**; the entire PRET
series landed **2026-08-17/18**. So a `v0.10.0` database with any team in it lacks the
`pret4_builtin_materialize` marker, hits the `raise`, and `pg:schema` aborts — Railway's preDeploy
halts and the old code keeps serving.

The refusal is **correct and well-built** (it fails in the safe direction). What was missing is the
release it points at.

### CI cannot see this, and already says so

`scripts/migrate-from-existing.mjs:18-24`, in its own words:

> *"Every scratch database is created EMPTY, so a migration is only ever exercised against zero rows…
> `20260818210000_pret6_retire_access_enforcement.sql` is the live proof — against a populated database
> it aborts the rollout … and against this lane it is **green every time**."*

The gap was documented. What was not documented is its consequence for the **next release**: a green
lane is not evidence that an installed user can upgrade.

## Decision

**1. Two releases, in the order the release notes already prescribe.**

| | commit | is | why |
|---|---|---|---|
| **`v0.11.0`** | **base** `803122ff` (PRET-5, 2026-08-18); the **tag target** is the version/changelog commit on top of it | the last state **before** the retirement | this is the "prior release" the notes send operators through |
| **`v0.12.0`** | current `main` | the retirement | now reachable by a documented path |

`803122ff` verified: PRET-6's **direct parent**; an ancestor of `main`; carries
`20260811160000_access_enforcement_flag.sql` and `20260817120000_autoflip_hold.sql`; does **not**
carry the PRET-6 migration; and its own CI was **green (8/8 checks)**.

**The release branch gets NO CI, and that is a gap this slice must close by hand.** `.github/workflows/ci.yml` fires on
`pull_request` and `push` to `main`/`staging` only, so pushing `release/v0.11.0` and its tag triggers
**nothing** — the actual tag target (base + the version/changelog commit) would otherwise be tagged
having never been run. Before tagging: run the full local verification against that exact SHA, and
perform the sandbox deployment `docs/RAILWAY-TEMPLATE.md` already requires per release. Neither is
automated here; both are named steps.

**2. `v0.11.0` is a BRANCH as well as a tag, because Railway cannot track a tag.** Railway's GitHub
source is a *connected branch* — its own docs describe only a trigger branch, and the repo's install
paths name `main`. An operator whose service tracks `main` therefore has no way to deploy a tag. So
`release/v0.11.0` exists as a branch they can repoint at, deploy, let converge, and then repoint away
from. **A tag alone would have been undeployable by exactly the fleet that needs it** (narrowed after
review: there is no *supported, fleet-wide connected-source* path to select a tag — a service that
already deployed that SHA could redeploy it, which no pre-flip install has) — which would
have made the "two releases" answer correct on paper and useless in practice.

**3. The branch carries ONE commit on top of `803122ff`:** the version moved to `0.11.0` at all three
sites, plus its CHANGELOG section. Retro-tagging `803122ff` unchanged would ship a `v0.11.0` whose
`package.json` reads `0.10.0` (measured — it predates the bump ritual), and "what version am I
running" is the first question an operator upgrading through it will ask.

**4. FOUR steps, not two — because my first sequence recreated the freeze.** Review caught that
"cut `v0.11.0`, then declare it" reintroduces exactly the red window RELPTR-1 removed: the moment the
tag exists, **every open PR whose `DEFAULT_TAGS` ends at `v0.10.0` fails `DEFAULT_TAGS is stale`.**
Declaring it *first* is what keeps the repo green, and `nextTagPolicy`'s pending slot is precisely the
affordance for that.

| # | step | why this order |
|---|---|---|
| 1 | **PR A on `main`** — declare `v0.11.0` (pending; it does not exist yet) | legal, because only the newest declared tag may be absent — and it means no PR goes stale when the tag appears |
| 2 | **cut `release/v0.11.0` + tag `v0.11.0`** | now declared, so nothing reddens |
| 3 | **PR B on `main`** — declare `v0.12.0` (pending), bump the version, date the changelog, ship the agreement guards | `v0.11.0` now exists, so declaring a second pending tag is legal |
| 4 | **tag `v0.12.0`** on the merged PR B commit | |

Declaring **both** while neither exists throws `unknown git tag: v0.11.0` (verified by running it) —
the middle-hole rule. So the machinery enforces the sequence the release notes require, and the
two-PR split is what keeps every step green.

A second, better consequence: once `v0.11.0` exists and is declared, the migration lane starts
exercising **`v0.11.0 → current`** — structurally testing the very upgrade the fleet must perform.

**4a. The agreement guards therefore ship in PR B, not PR A** — and the reason is worth stating,
because it is a genuine constraint rather than convenience. Guard (b) says *the newest declared tag
equals `v${package.json.version}`*. In PR A the newest declared tag is `v0.11.0` while `main`'s
`package.json` still reads `0.10.0` — and it **should**, because `v0.11.0`'s content is `803122ff`,
not `main`. `main`'s next release is `v0.12.0`. Shipping guard (b) in PR A would make the guard red on
a correct tree.

**4b. VERIFIED: running `v0.11.0` actually writes the marker, and at BOOT — not on a tick.** This was
the plan's load-bearing assumption and it is now checked at `803122ff`, not at HEAD:

- `instrumentation.ts:46-48` calls `materializeBuiltinMembershipOnce(adminClient())` **during boot**,
  logging `[boot] pret4 builtin materialization ran (explicit posture state live)`;
- `lib/ingest/scheduler.ts:71-72` calls it again on the scheduler tick as a retry, so a failed boot
  self-heals rather than stranding the fleet;
- the function writes `migration_markers` only after `ensureBuiltins` succeeds for every team
  (`lib/access/groups.ts:193-208`).

**CORRECTION, from review: "self-heals" was too strong, and a log line is NOT the gate.** The
scheduler retry runs only when ingestion is enabled — `instrumentation.ts:55` gates the whole scheduler
on `INGEST_POLL_ENABLED !== "false"`. A transient boot failure on a service with ingestion turned off
leaves a **healthy-looking `v0.11.0` with no marker**, and `v0.12.0` then refuses exactly as before.

So the runbook's gate is a **direct database query**, with the log line as supporting evidence only:

```sql
select exists (select 1 from migration_markers where name = 'pret4_builtin_materialize') as marker_ok,
       (select count(*) from teams where access_enforcement = 'permissive') as permissive_left;
```

Both must read `t` and `0`. That also covers the second half of the precondition — no team left
`permissive` — which is genuinely tick-driven (auto-flip) or a manual CLI flip. And **applying the
schema is not enough**: the marker is written by the running application, so a completed `v0.11.0`
boot is required, not merely a successful migration.

**5. Three agreement guards** — the version's three sites agree; the newest `DEFAULT_TAGS` entry
equals `v${package.json.version}`; `CHANGELOG.md` has a section for that version. Each parses JSON
paths rather than matching text: a grep for `0.10.0` hits **eight** unrelated `"node": ">=0.10.0"`
engine constraints in `package-lock.json`.

The "newest entry" comparison uses the **same semver comparator** the policy uses, not `.at(-1)` —
otherwise a reordered list disagrees with the policy about which tag is pending.

**6. `test/guards/release-tag-policy.test.ts` is decoupled from `DEFAULT_TAGS`'s cut state.** Two of
its assertions assume the declared list is fully cut, so declaring a release turns them red — a
miniature of the deadlock RELPTR-1 removed. Policy semantics move to fixture lists; the live check
asserts only that the declared list is in a **legal** state, which is true mid-preparation too.

**7. The CHANGELOG must carry PRET-4/5/6.** The four existing `[Unreleased]` bullets omit them
entirely — the deleted permissive mode, the mandatory ordered upgrade, and the deployment refusal
(`docs/RELEASE-NOTES-pret6.md:31-55`). Publishing that as `v0.12.0`'s notes would hide the one thing a
pinned operator must act on. This slice adds a pointer to the PRET-6 release notes and the upgrade
order; it does **not** editorialise 168 commits it did not review.

## Scope

**THIS PR is step 1 of four (PR A).** Deliberately small, because its only job is to make cutting
`v0.11.0` safe:

- declare `v0.11.0` in `DEFAULT_TAGS` (pending — it does not exist yet);
- decouple `test/guards/release-tag-policy.test.ts` from `DEFAULT_TAGS`'s cut state, or that
  declaration turns it red;
- fix the manual-flip command published in `docs/RELEASE-NOTES-pret6.md:18` — it omits
  `--conditions react-server`, and `lib/access/posture.ts:1` imports `server-only`, so an operator
  following the **mandatory** upgrade path throws before reaching the database. Every other invocation
  in this repo carries the condition (`package.json:28`, the admin skill, `docs/CI-ARCHITECTURE.md`);
- `docs/RELEASING.md` gains the fleet upgrade procedure, with the SQL gate above.

**Steps 2–4, named and NOT in this PR:** cut `release/v0.11.0` + tag; then PR B (declare `v0.12.0`,
bump the version, date the changelog, ship the three agreement guards); then tag `v0.12.0`.

**Cut, each with the reason:**
- **The agreement guards** — Decision 4a: guard (b) would be red on a correct tree in PR A.
- **The version bump and CHANGELOG dating** — they belong to `v0.12.0`, which is PR B.
- **Publishing either GitHub Release** — outward-facing on a public repo; waits for the operator.
- **Automating the sandbox verification** `docs/RAILWAY-TEMPLATE.md` requires per release — a real
  gate, named as a human step rather than skipped quietly.
- **Engineering a safe single-step upgrade** — the considered alternative to two releases; larger, and
  unnecessary once the intermediate release exists.
- **`ingestion/pyproject.toml`** — a fourth version literal, but a separately packaged sidecar
  (`ingestion/NOTICE`) with independent versioning. Explicitly out of scope, not silently ignored.
- **The branch cutover (option B)** — RELPTR-3, and better motivated now: under B an install tracking
  `main` receives releases *in order*, which is the whole subject of this document.

## Acceptance criteria

1. **unit** — `DEFAULT_TAGS` declares `v0.11.0`, and `nextTagPolicy` reports it as PENDING against a
   tag set that lacks it — i.e. the declaration is legal before the tag exists, which is the property
   that keeps every open PR green when the tag appears.
2. **unit** — a guard pins that at most ONE declared tag is pending, so a future editor cannot declare
   two and reintroduce the middle-hole throw.
3. **unit** — `test/guards/release-tag-policy.test.ts` no longer assumes `DEFAULT_TAGS` is fully cut:
   its policy assertions run against fixture lists, and the live check asserts only that the declared
   list is in a LEGAL state (which is true mid-preparation).
4. **unit** — that decoupling is proven by construction: the live check passes with the declaration in
   place, and the fixture assertions are unchanged in meaning.
5. **unit** — `docs/RELEASE-NOTES-pret6.md`'s operator commands all carry `--conditions react-server`
   (or invoke `npm run admin`), asserted against every fenced `scripts/admin.ts` invocation in the file
   — the mandatory path must not throw before it reaches the database.
6. **unit** — a guard pins that no doc in `docs/` publishes a bare `npx tsx scripts/admin.ts` command,
   since the failure is silent-until-run and the repo already standardises the condition.
7. **unit** — `docs/RELEASING.md` documents the fleet upgrade procedure and contains the SQL that
   checks BOTH preconditions (`pret4_builtin_materialize` present, zero `permissive` teams), because a
   log line is not a gate when the retry is disabled with ingestion.

## What would falsify this

- **A populated `v0.10.0` install still refused when upgrading to `v0.11.0`** — the intermediate
  release does not satisfy PRET-6's precondition and the plan is wrong.
- **An open PR going red the moment `v0.11.0` is tagged** — the declare-first ordering did not work,
  and the freeze RELPTR-1 removed is back.
- **The marker absent after a completed `v0.11.0` boot** — Decision 4b's boot path did not run, and
  with ingestion disabled there is no retry to save it.
- **The migration lane going red on `v0.11.0 → current`** after declaration — the two states disagree
  structurally in a way nobody expected.
- **An operator hitting a `server-only` throw** on the mandatory flip command — the doc fix missed an
  invocation.
