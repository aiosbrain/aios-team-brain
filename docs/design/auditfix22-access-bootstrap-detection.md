# A forbidden system-project grant is DETECTED, and its failure is visible — AUDITFIX-22

**Status:** spec, round 0. No code written. Split out of AUDITFIX-3 (merged, PR #646), which shipped
the PREVENTION half and deliberately shipped no detection — §0a says why that gap is the thing to
close next.

**Build with:** opus / high — it changes what an operator's health surface says, and a detector that
reports green while broken is worse than none.

**Deps:** AUDITFIX-3 (merged 3757aa4c) — this consumes its `isSanctionedSystemEdge` predicate.
Repair is AUDITFIX-21 and is NOT required first (§3).

---

## What and why

**What:** three things, in dependency order — (1) make a per-team `access_bootstrap` failure actually
appear on the health card, (2) census already-`system` projects on every scheduler tick so a forbidden
edge is found without an operator asking, (3) add the inverse assertion to `assessAccessHealth` for the
operator-asks path.

**Why:** AUDITFIX-3 shipped a refusal that can **wedge a team's bootstrap and its context backfill**,
and its own §3b recorded that the resulting failure row is masked. That is a gap I created knowingly
and said I would close. Closing it also makes the *pre-existing* wedge — a reserved-slug initiative,
shipped since slice 3 — visible for the first time.

## 0. Terrain, measured before designing

### 0a. What AUDITFIX-3 left open, in its own words

`ensureSystemProject` now refuses to adopt a `source` project carrying an unsanctioned edge, and
`ensureAccessBootstrap` returns early on that leg (`lib/access/bootstrap.ts`). `backfillTeamContext`
then re-runs bootstrap and **returns before processing a single item** when it fails
(`lib/projects/context/backfill.ts:45-47`). So a wedged team stops partitioning new content — and the
leg that should say so is green.

### 0b. The masking, re-derived against MERGED code — and it is HALF-ALREADY-FIXED

This is the finding that changes the framing, and I did not have it when I wrote the AUDITFIX-3 split.

`STREAK_SQL` (`lib/ingest/pipeline-health.ts:296-331`) has **two** per-source computations:

| CTE | partition | state |
|---|---|---|
| `scoped` / `streaks` | `(source, team_id)` | **already correct** |
| `newest` | `distinct on (source)` | **still mixes team and global rows** |

And the module's own header already explains why the partition had to be `(source, team_id)`
(`:266-272`): *"at least one source writes BOTH: `access_bootstrap` records a per-team `ok=false` row
for each FAILING team, plus an unconditional instance-wide heartbeat every tick … The codebase has
been bitten by the same mixing before — `context_backfill_all` exists as its own source precisely
because a global row masked per-team rows under `distinct on`. Found in spec review."*

So the mixing was found once, and fixed for the **streak** only. The **leg selection** — the `ok`,
`errors` and `finished_at` an operator actually reads — is still `distinct on (source)` ordered
`finished_at desc, id desc`, and `runAccessBootstrap` writes the global heartbeat **after** the
per-team failures (`lib/ingest/scheduler.ts`). The later global row wins, and because the join is
`s.team_id is not distinct from n.team_id`, the streak shown is the *winning partition's* — so the
per-team failure contributes neither verdict nor duration.

**This slice is not a new idea; it is the other half of a fix the repo already started.**

⚠️ **Under the ORDINARY successful record sequence** — round 1 MEDIUM 1, and the qualifier is earned.
`recordIngestRun` never throws and swallows its own insert failure (`lib/ingest/runs.ts:55-59`), so a
global row that fails to insert does not mask; nor does a backward clock step between the two writes.
Neither is a repair — nothing downstream corrects the verdict — but "always masks" would be a false
universal, and this program has already shipped two of those.

### 0c. Production, read-only, 2026-08-23 UTC

| | |
|---|---|
| teams | **1** |
| `access_bootstrap` rows, last 7d | **334 global · 0 team-scoped** — the per-team row is written ONLY on failure, and there have been none |
| `context_backfill` rows, last 7d | **314 team-scoped · 314 `context_backfill_all` global** — the target shape, already running at this volume |
| `access_bootstrap` cadence, 30d | **589 scheduler runs · avg gap 30.2 min · p95 38.5 · worst 85.8** |
| forbidden edges | **0** (AUDITFIX-3's census, re-run) |

Two things follow. **The row-growth cost of per-team success rows is one row per team per tick** —
`context_backfill` already pays exactly that and nothing prunes `ingest_runs`, which is a known,
recorded follow-up rather than a new problem. And **`access_bootstrap` has no staleness override**, so
it sits on the 3h default with ~94 min of headroom over the measured worst gap.

### 0d. What is NOT measured

Nothing here measures a fleet with more than one team, because this fleet has one. Every claim about
per-team behaviour is therefore derived from the code and proven in the dm tier with **two** seeded
teams, not observed in production. Stated so no reviewer has to ask.

## 1. The rule

> **A per-team access failure is visible on THAT team's health card and nowhere else; a forbidden
> edge on an already-`system` project is found by the scheduler, not by an operator asking; and
> neither the census nor the health check may report healthy from a read it could not complete.**

## 2. The design

### 2a. The ledger: per-team rows every tick, and a global row ONLY for fleet-level failure

⚠️ **My first draft added a second source, `access_bootstrap_all`, and claimed "both halves are
required". That claim was false — round 1's BLOCKER 1 found a cheaper design, which is the SECOND time
in two slices I have eliminated alternatives too confidently.** The elimination is the part of my
reasoning to distrust, not the conclusion.

`runAccessBootstrap` (`lib/ingest/scheduler.ts`) changes to:

1. write an `access_bootstrap` row **per team, every tick, on success as well as failure**;
2. write the instance-wide (`team_id is null`) row **only when the failure is fleet-level** — the
   `teams` read failed, the runner threw, or **zero teams were enumerated**.

**Why this beats the extra source.** On an ordinary tick, a team's own row *is* its heartbeat, so a
global success row has no job left — and a global success row is precisely what does the masking. The
global row's `ok` is `!globalFailure` today (`lib/ingest/scheduler.ts:328-337`), so it is `true` on
every ordinary tick and, being written last, wins `newest`. Delete that row and the masking has nothing
to work with. The semantics stay right in every case:

| case | what an operator sees |
|---|---|
| team A fails, B succeeds | A's card red, B's green — each from its own newest row |
| the `teams` read fails | one global failure row, newest for every team, so every card reds — correct, because nothing converged |
| the next readable tick | per-team successes are newer than the global failure and heal every card |
| historical global success rows | older than the first post-deploy per-team row, so they stop masking after one tick |

**The zero-teams case is mine, not the review's, and it is why clause 2 says "or zero teams".** With a
global row written only on *failure*, an instance whose `teams` read succeeds and returns EMPTY would
write no row at all — the leg vanishes from `legs` entirely and staleness cannot fire on a missing leg,
which is the `auto_flip` shape already documented in `lib/ingest/pipeline-health.ts`. A fleet with no
teams is a real state on a fresh self-hosted install.

**What this design AVOIDS, all of which the extra source would have cost** (round 1 HIGH 3, re-derived —
each is a real registry, not bookkeeping): a new entry in `INGEST_LEG_SOURCES`, whose guard fails the
build on an undeclared source (`lib/ingest/leg-ledger.ts:21`); the `RECORDS_EVERY_POLL`
default-threshold allowlist; the banner's label map, or an operator reading a raw slug
(`components/admin/pipeline-health-banner.tsx:9`); **two** legs ageing stale together and reporting one
stopped stage as two broken ones; and a weakened per-source cap in `diversifyBySource`
(`lib/ingest/runs.ts:106`), where the pair could crowd the 50-row Recent Runs panel.

**It does require a return-shape change.** `ensureAccessBootstrapAllTeams` returns
`{ teams: number; failed: [...] }` (`lib/access/bootstrap.ts`), which cannot drive per-team SUCCESS
rows without a second `teams` query. It must return per-team **outcomes** instead.

**Staleness needs no map entry**, because no new source exists. `access_bootstrap` keeps the 3h
default it has today, now aged from each team's own row.

⚠️ *Corrected from my first draft (round 1 MEDIUM 2): I wrote that a sibling's gaps would be
"identical by construction". That was false even for the design I have now dropped — each row is an
independent best-effort insert whose failure is swallowed, and a process can stop between them. Cadence
is an expectation, never a construction guarantee.*

### 2b. The census: EVERY system project, in the all-teams wrapper, regardless of convergence

The census reads every `projects.kind = 'system'` row for the team, joined to its `project_groups`
edges and their groups, and reports any edge that fails AUDITFIX-3's `isSanctionedSystemEdge`.

⚠️ **It covers every `kind='system'` project, not the two reserved slugs — round 1 BLOCKER 2.** My
draft said "the two system projects", but AUDITFIX-3's writer guard protects *any* `kind='system'`
project (`lib/access/system-projects.ts:78`) and the schema constrains `kind`, never the slug. So
`projects(kind='system', slug='legacy-system')` granted to `vendors` is refused at the writer yet would
be invisible to a two-slug census — detection narrower than the prevention it is meant to observe.
That row can only arise out of band, which is exactly the population this slice exists for.

⚠️ **It lives in `ensureAccessBootstrapAllTeams`, and runs after each team's convergence attempt
REGARDLESS of its result — round 1 BLOCKER 3, which killed my placement.** I had put it at the end of
`ensureAccessBootstrap`, which has **six** early returns before that point (`lib/access/bootstrap.ts`:
builtins, each of the two system projects, the group read, missing builtins, and each grant). Concrete
surviving defect: General is wedged by a reserved-slug initiative, so every tick returns at the General
leg — and a forbidden `vendors` edge on an already-system External Shared is **never named**, on any
tick, forever. The two failures are aggregated so neither hides the other.

**This also satisfies the converge-before-census rule** inherited from AUDITFIX-3's round 2 (HIGH 2):
convergence is attempted first, so a missing sanctioned edge is restored before the census reports —
the census must never be the reason a team stays half-wired.

**Fails closed:** a census read error is that team's failure, never "no forbidden edges".

### 2c. The operator-asks path — and the CLI's own words have to change with it

`assessAccessHealth` gains the inverse assertion: a `kind='system'` project holding an unsanctioned
edge is reported.

⚠️ **It must read `projects.kind`, and round 1's HIGH 4 is why.** The function's project read selects
`id, slug` only (`lib/admin/access-health.ts:68`). An implementation that censused the two reserved
SLUGS regardless of kind would classify the legitimate creator grant on a reserved-slug
`kind='initiative'` project as over-exposure — **reversing the exact AUDITFIX-3 ruling** that such a
project must stay grantable to its creator. AC12 is the control for that.

⚠️ **Widening `blockers` changes what the CLI PRINTS, and leaving that alone would ship false operator
output — round 1 HIGH 5.** Today the field means lock-OUT (`lib/admin/access-health.ts:25-30`) and
`printHealth` renders `health: LOCKOUTS` (`scripts/admin.ts:96-101`). A team with no lockout but one
forbidden edge would print `LOCKOUTS`, which is simply untrue. So the widening is: `blockers` becomes
*"hard reasons to refuse — a human locked OUT, or a group let IN that the substrate never
sanctioned"*, the doc comment says so, **and the CLI verdict becomes `ACCESS VIOLATIONS`**. Filing it
under `warnings` instead is not an option: warnings are non-fatal, so `healthy` would stay `true` — the
report-green-while-broken failure this slice exists to prevent.

## 3. Scope

**In:** `lib/ingest/scheduler.ts` (the ledger) · `lib/access/bootstrap.ts` (the per-team outcome return
+ the census) · `lib/admin/access-health.ts` (the inverse assertion + the `blockers` doc) ·
`scripts/admin.ts` (the verdict text) · `docs/ARCHITECTURE.md`.

**Out:**
- **Repairing** a forbidden edge — AUDITFIX-21. This slice REPORTS; it never deletes. A fail-open
  destructive repair is worse than a reported hole (inherited from AUDITFIX-3 §3).
- **A second health leg.** §2a — the design that needed one is dropped.
- **Making `newest` team-aware in general.** Still the wider, riskier change; the per-team-rows route
  reaches the same outcome for this leg without touching the others.
- **`ingest_runs` retention.** ⚠️ *Corrected, round 1 MEDIUM 3: my draft said this is "not materially
  worse" because `context_backfill` already pays one row per team per tick. **That is false on a
  multi-team fleet** — `backfillAllTeams` is budgeted and may defer teams
  (`lib/projects/context/backfill.ts:238-249`), and the scheduler records rows only for the teams it
  actually processed (`lib/ingest/scheduler.ts:399`), so it does NOT pay row-per-team-per-tick.* The
  honest delta is **`teams successfully enumerated × scheduler ticks`**. On this fleet that is one row
  per tick (§0c). **Fleet-scale storage and query impact is UNVERIFIED**, because this fleet has one
  team; retention remains the pre-existing follow-up recorded in the
  `lib/ingest/pipeline-health.ts` header, and this slice does not discharge it.

## 4. Acceptance

⚠️ **Two shapes are pre-empted rather than rediscovered, because AUDITFIX-3 shipped FIVE criteria that
were green while testing nothing:** every fixture precondition is asserted, and every fault injector
fails **reads only** (an injector that also kills the write cannot observe the damage it exists to
catch).

⚠️ **And every "visible" criterion goes through the SHIPPED consumer at the CONFIRMED threshold —
round 1 BLOCKER 4.** `getPipelineHealth` exposes a lone failure as `legs[].ok === false` but keeps it
out of `failing` until `FAILURES_TO_CONFIRM = 2` (`lib/ingest/failure-streak.ts:36`,
`lib/ingest/pipeline-health.ts:454`), and the banner renders only `failing`
(`components/admin/pipeline-health-banner.tsx:57`). So a criterion that ran ONE failed tick and
asserted `legs.find(…).ok === false` would pass while `healthy === true` and **no banner appears at
all** — the masking fixed at the SQL layer and the claimed outcome unproven.

- **AC1 — a per-team failure is LOUD on that team's card (dm):** seed TWO teams, wedge one (a
  reserved-slug `initiative` — the pre-existing shipped wedge), run **two** scheduler record
  sequences, then read `getPipelineHealth(wedgedTeam)` and assert all of: `access_bootstrap` is in
  **`failing`**, its `failureClass` is **`confirmed`**, and **`healthy === false`**.
- **AC2 — the OTHER team stays green (dm):** `getPipelineHealth(healthyTeam)` has `access_bootstrap`
  absent from `failing` and `healthy === true`. *Without this, reddening every card passes AC1.*
- **AC3 — a HEALED team goes fully green (dm):** from AC1's **confirmed** red state, remove the wedge,
  run one successful tick, and assert `ok`, `failureClass === "ok"`, `failingSince === null`,
  `access_bootstrap` absent from `failing`, and `healthy === true`. ⚠️ *Round 1 HIGH 1 — asserting only
  "green after" cannot distinguish healed from never-visibly-failed, and mutation 1 would survive it.*
- **AC4 — an ordinary tick writes NO `team_id is null` row (dm):** with two healthy teams, the tick
  writes exactly two `access_bootstrap` rows, both team-scoped. *The global success row is the thing
  that masks; its absence is the mechanism AC1 depends on.*
- **AC5 — a FLEET-level failure still writes the global row (dm):** with the `teams` read faulted, one
  `team_id is null` `access_bootstrap` row is written `ok:false`, and `getPipelineHealth` reds for a
  team that has no row of its own. *The `teamId: "*"` contract must survive the redesign.*
- **AC6 — ZERO teams still writes a heartbeat (dm):** on an instance with no teams, the tick writes one
  global `access_bootstrap` row rather than nothing. *Mine, not the review's: a leg that writes no row
  vanishes from `legs`, and staleness cannot fire on a missing leg.*
- **AC7 — the census finds a forbidden edge on a RESERVED-slug system project (dm):** planted out of
  band on `general`; `ensureAccessBootstrapAllTeams` returns that team failed with the edge named.
- **AC8 — and on a NON-reserved `kind='system'` project (dm):** `slug='legacy-system'`, granted to
  `vendors`. ⚠️ *Round 1 BLOCKER 2 — a two-slug census satisfies AC7 while this edge stays invisible to
  both the scheduler and the operator, making detection narrower than the writer guard it observes.*
- **AC9 — the census runs even when CONVERGENCE FAILED for that team (dm):** wedge General with a
  reserved-slug initiative **and** plant a forbidden edge on an already-system `external-shared`; the
  team's report names **both**. ⚠️ *Round 1 BLOCKER 3 — with the census at the end of
  `ensureAccessBootstrap`, six early returns mean this edge is never named on any tick, forever.*
- **AC10 — convergence still happens BEFORE the census (dm):** seed a forbidden edge **and** a missing
  sanctioned edge; the call reports the forbidden edge **and** the missing sanctioned edge is restored.
  ⚠️ *Round 1 HIGH 2 — the three grants are sequential, so removing whichever edge is granted FIRST
  would pass while a census wedged between grants still blocks the other two. This criterion removes
  the **last** sanctioned edge, and §4's mutation table places the census before and between grants.*
- **AC11 — the census FAILS CLOSED (dm):** with the edge read faulted, the team is reported failed; it
  never reports "no forbidden edges" from a read it could not complete.
- **AC12 — a reserved-slug INITIATIVE with its legitimate creator grant is NOT reported (dm):** by the
  census **and** by `assessAccessHealth`. ⚠️ *Round 1 HIGH 4 — a kind-blind implementation reverses
  AUDITFIX-3's ruling that such a project stays grantable to its creator.*
- **AC13 — a clean team is not reported (dm):** `ensureAccessBootstrapAllTeams` returns it unfailed.
  *Without this, a census that always failed would pass AC7-AC11.*
- **AC14 — `assessAccessHealth` reports the edge and goes `healthy:false` (dm):** the blocker names the
  project and the group.
- **AC15 — the CLI PRINTS the widened meaning (unit):** `printHealth` on a health object whose only
  blocker is an over-exposure renders **`ACCESS VIOLATIONS`**, not `LOCKOUTS`. ⚠️ *Round 1 HIGH 5 —
  asserting only the returned object leaves the operator reading a false word.*
- **AC16 — `assessAccessHealth` stays healthy on a clean team (dm):** the inverse control for AC14.
- **AC17 — `assessAccessHealth` FAILS CLOSED (dm):** with its edge read faulted, it does not certify
  `healthy:true`.

**Mutation coverage, one per enforcement point, each reddening ITS OWN criterion:**

| # | mutation | must redden |
|---|---|---|
| 1 | write the per-team row only on failure | AC3 |
| 2 | write a global `ok:true` row on ordinary ticks (the pre-slice shape) | AC1 |
| 3 | make the global row's `ok` ignore a fleet-level failure | AC5 |
| 4 | skip the global row when zero teams are enumerated | AC6 |
| 5 | census only the two reserved slugs | AC8 |
| 6 | census only `general`, not `external-shared` | AC7 |
| 7 | skip the census when that team's convergence failed | AC9 |
| 8 | run the census BEFORE the three grants | AC10 |
| 9 | run the census BETWEEN the first and second grant | AC10 |
| 10 | swallow the census read error | AC11 |
| 11 | ignore `projects.kind` in the census / `assessAccessHealth` | AC12 |
| 12 | delete `assessAccessHealth`'s new blocker | AC14 |
| 13 | keep the CLI verdict text as `LOCKOUTS` | AC15 |
| 14 | swallow `assessAccessHealth`'s edge-read error | AC17 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| Losing the global success row hides a stopped scheduler | alarm death | per-team rows are the heartbeat and age from each team's own row; AC6 covers the zero-team case where none would be written |
| A healed team stays red forever | alarm death | AC3 asserts the heal from a **confirmed** red state; mutation 1 |
| The per-team rows red every team's card | alarm noise, shipped decision reversed | AC2 |
| The census misses the population it is meant to watch | detection narrower than the prevention it observes | AC8 (non-reserved system project), mutations 5 and 6 |
| The census never runs on a wedged team | the loudest case is the silent one | AC9, mutation 7 |
| The census fires before convergence and leaves a team half-wired | the detector CAUSES the damage | AC10, mutations 8 and 9 |
| A kind-blind census flags a legitimate initiative grant | AUDITFIX-3's ruling reversed | AC12, mutation 11 |
| The CLI keeps printing `LOCKOUTS` for an exposure | false operator output | AC15, mutation 13 |
| Row growth on an unpruned table | `teams enumerated × ticks` extra rows | §3 — one row/tick on this fleet; **fleet-scale impact unverified** and stated as such |

## 6. What this slice does NOT prove

It does not prove a forbidden edge can be REPAIRED — `revokeProjectFromGroup` still refuses every
`kind='system'` revocation, so a detected edge remains raw-SQL-only until AUDITFIX-21. A merge here
should be read as *"you will now be told"*, not *"it is now fixable"*.

**Nothing is built. No code exists for this slice.**

## 7. Round 1 — BLOCKED, and its first blocker is a mistake I made one slice ago

| # | finding | re-derived | outcome |
|---|---|---|---|
| **B1** | a cheaper ledger design exists, so "both halves are required" is false: keep ONE source, write per-team rows every tick, and write the global row only for fleet-level failure | **CONFIRMED.** The global row is `ok: !globalFailure` (`lib/ingest/scheduler.ts:328-337`), i.e. `true` on every ordinary tick and written last — delete it and the masking has nothing to work with | **ADOPTED**, §2a rewritten; the extra source is dropped along with every registry it would have needed |
| **B2** | §2b censused two slugs; the writer guard protects EVERY `kind='system'` project | **CONFIRMED** (`lib/access/system-projects.ts:78`; the schema constrains kind, not slug) | **ADOPTED** — census is kind-keyed; **AC8** |
| **B3** | a census at the end of `ensureAccessBootstrap` never runs on a wedged team — six early returns precede it | **CONFIRMED** by grep: `builtins`, both system projects, the group read, missing builtins, each grant | **ADOPTED** — it moves to the all-teams wrapper and runs regardless of convergence; **AC9** |
| **B4** | AC1 could pass with `legs[].ok === false` while `healthy` stayed true and no banner rendered — `FAILURES_TO_CONFIRM = 2` | **CONFIRMED** (`lib/ingest/failure-streak.ts:36`, `pipeline-health.ts:454`, `pipeline-health-banner.tsx:57`) | **ADOPTED** — every visibility criterion runs two ticks and asserts `failing` + `failureClass` + `healthy` |
| **H1** | AC3 could not distinguish healed from never-visibly-failed | **CONFIRMED** — same confirmation threshold | **ADOPTED** — AC3 heals from a confirmed red state |
| **H2** | AC8 (old) did not prove the census follows ALL THREE grants — they are sequential | **CONFIRMED** (`lib/access/bootstrap.ts` grant loop) | **ADOPTED** — **AC10** removes the LAST edge; mutations 8 and 9 |
| **H3** | a new source is not registration-free: `INGEST_LEG_SOURCES` guard, the default-threshold allowlist, the banner label map, two legs ageing stale together, and a weakened `diversifyBySource` cap | **CONFIRMED** — `lib/ingest/leg-ledger.ts:21` is a real build-enforced registry | **MOOT under B1**, and it is the strongest evidence that B1 is genuinely cheaper |
| **H4** | `assessAccessHealth` reads `id, slug` with no `kind`, so a slug-keyed census would flag a legitimate initiative grant | **CONFIRMED** (`lib/admin/access-health.ts:68`) | **ADOPTED** — **AC12**, mutation 11 |
| **H5** | widening `blockers` makes the CLI print `health: LOCKOUTS` for a pure exposure — false output | **CONFIRMED** (`scripts/admin.ts:96-101`) | **ADOPTED** — verdict becomes `ACCESS VIOLATIONS`; **AC15** asserts the FORMATTER |
| **M1** | the masking derivation is right for the ordinary sequence but is not unconditional | **CONFIRMED** — `recordIngestRun` swallows its own insert failure (`lib/ingest/runs.ts:55-59`) | **ADOPTED** — §0b qualified |
| **M2** | "identical gaps by construction" is disproven by the writer | **CONFIRMED** | **ADOPTED** — §2a says cadence is an expectation, never a guarantee |
| **M3** | the row-growth comparison to `context_backfill` is false on multi-team fleets | **CONFIRMED** — `backfillAllTeams` is budgeted and defers teams (`lib/projects/context/backfill.ts:238-249`) | **ADOPTED** — §3 states the real delta and marks fleet scale UNVERIFIED |
| **M4** | mutation coverage missed the most dangerous survivors | **CONFIRMED** | **ADOPTED** — the table is 14 rows |

⚠️ **B1 is the same mistake as one slice ago, and that is the pattern worth naming.** On AUDITFIX-3 I
asserted "neither cheap fix works" and the third option was in the same file; here I asserted "both
halves are required" and the third option was in the same function. **A negative universal of mine
about design alternatives has now been wrong twice running.** The rule I am taking from it: when I
write "the only way" or "both are required", that sentence is a research task, not a conclusion.

**Nothing is built. No code exists for this slice.**
