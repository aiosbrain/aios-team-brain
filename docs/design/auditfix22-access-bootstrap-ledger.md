# A per-team access failure is LOUD on that team's card — AUDITFIX-22

**Status:** spec, round 2 folded, **narrowed to the ledger**. No code written. Two rounds, both
BLOCKED; round 2 said the slice should split and it was right — the census and the operator surface
are now **AUDITFIX-23** (§3a).

**Build with:** opus / high — it changes what an operator's health surface says, and a detector that
reports green while broken is worse than none.

**Deps:** none to build. AUDITFIX-23 depends on THIS, not the other way round: a census whose findings
are reported through a masked leg is invisible.

---

## What and why

**What:** `access_bootstrap` becomes a **per-team** ledger leg. A row is written for every team on
every tick — success as well as failure — and the instance-wide row is written only when the failure
is fleet-level.

**Why:** AUDITFIX-3 (merged, #646) shipped a refusal that can **wedge a team's bootstrap and its
context backfill**, and its own §3b recorded that the resulting failure row is masked. I created that
gap knowingly. This closes it — and in doing so makes the *pre-existing* wedge, a reserved-slug
initiative shipped since slice 3, visible for the first time.

## 0. Terrain, measured before designing

### 0a. The masking, re-derived against MERGED code — and it is HALF-ALREADY-FIXED

`STREAK_SQL` (`lib/ingest/pipeline-health.ts`) has **two** per-source computations:

| CTE | partition | state |
|---|---|---|
| `scoped` / `streaks` | `(source, team_id)` | **already correct** |
| `newest` | `distinct on (source)` | **still mixes team and global rows** |

The module header already explains why the partition had to change, and names `context_backfill_all`
as a previous instance of the same bug — *"Found in spec review."* So the mixing was found once and
fixed for the **streak** only. The **leg selection** — the `ok`, `errors` and `finished_at` an
operator reads — still mixes, and because the join is `s.team_id is not distinct from n.team_id`, the
streak reported is the *winning* partition's. The per-team failure contributes neither verdict nor
duration.

**This is the other half of a fix the repo already started.**

⚠️ **Under the ORDINARY successful record sequence**, not unconditionally (round 1 M1).
`recordIngestRun` never throws and swallows its own insert failure (`lib/ingest/runs.ts:55-59`), so a
global row that fails to insert does not mask, and neither does a backward clock step. Neither is a
repair — nothing downstream corrects the verdict — but "always masks" would be a false universal.

### 0b. The consumer has a confirmation threshold, and it changes every criterion

`getPipelineHealth` exposes a lone failure as `legs[].ok === false` but keeps it **out of `failing`**
until `FAILURES_TO_CONFIRM = 2` (`lib/ingest/failure-streak.ts:37`, `lib/ingest/pipeline-health.ts:462-464`),
and the banner renders only `failing` (`components/admin/pipeline-health-banner.tsx:57`). A criterion
that ran one failed tick and asserted `legs.find(…).ok === false` would pass **while no banner appears
at all**. Every visibility criterion below therefore runs **two** ticks and asserts the confirmed state.

A leg that is **absent** yields `healthy: true` — `getPipelineHealth`'s empty shape is
`{ legs: [], failing: [], healthy: true }` (`lib/ingest/pipeline-health.ts:351`). **A missing leg is
silent, not loud**, which is what makes §2b's zero-row cases matter.

### 0c. Production, read-only, 2026-08-23 UTC

| | |
|---|---|
| teams | **1** |
| `access_bootstrap`, last 7d | **334 global · 0 team-scoped** — the per-team row is written ONLY on failure, and there have been none |
| cadence, 30d | **589 scheduler runs · avg gap 30.2 min · p95 38.5 · worst 85.8** — against the 3h default it inherits |

### 0d. What is NOT measured

This fleet has **one team**, so every per-team claim is derived from code and proven in the dm tier
with **two seeded teams**, never observed in production. Fleet-scale storage and query impact is
**unverified** for the same reason.

## 1. The rule

> **Every team gets a durable `access_bootstrap` row of its own — at creation and on every tick,
> success as well as failure — and the instance-wide row is written only when the failure is
> fleet-level or there is no team to report on.**

## 2. The design

### 2a. Per-team rows, and a global row only for fleet-level failure

⚠️ **My first draft added a second source and claimed "both halves are required". That was false**
(round 1 B1) — and it is the SECOND time in two slices I eliminated alternatives too confidently
(§7). `runAccessBootstrap` (`lib/ingest/scheduler.ts`) becomes:

1. an `access_bootstrap` row **per team, every tick, on success as well as failure**;
2. the `team_id is null` row **only** when the `teams` read fails, the runner throws, or **zero teams
   were enumerated**.

**Why this beats a second source.** On an ordinary tick a team's own row *is* its heartbeat, so the
global success row has no job left — and it is precisely what masks: its `ok` is `!globalFailure`
(`lib/ingest/scheduler.ts:328-337`), so it is `true` on every ordinary tick and, written last, wins
`newest`. Remove it and the masking has nothing to work with.

| case | what an operator sees |
|---|---|
| team A fails, B succeeds | A's card red, B's green — each from its own newest row |
| the `teams` read fails, or the runner throws | one global failure row, newest for every team, so every card reds — correct, nothing converged |
| the next readable tick | per-team successes are newer than the global failure and heal every card |
| **zero teams enumerated** | one global **`ok:true`** heartbeat — §2b |

**What this AVOIDS**, each a real registry rather than bookkeeping (round 1 H3, re-derived): a new
entry in `INGEST_LEG_SOURCES`, whose guard fails the build on an undeclared source
(`lib/ingest/leg-ledger.ts:22`); the default-threshold allowlist; the banner's label map; **two** legs
ageing stale together for one stopped stage; and a weakened per-source cap in `diversifyBySource`
(`lib/ingest/runs.ts:106`).

**Staleness needs no map entry** — no new source exists, and `access_bootstrap` keeps the 3h default it
has today, now aged from each team's own row.

⚠️ *Corrected (round 1 M2): I had written that a sibling's gaps would be "identical by construction".
False — every row is an independent best-effort insert whose failure is swallowed, and a process can
stop between them. Cadence is an expectation, never a guarantee.*

### 2b. The three ways a team can end up with NO row — and what each does

A missing leg is silent (§0b), so this is the failure mode the design has to answer for, and round 2's
BLOCKER 1 found two cases my draft did not cover.

| case | today | this slice |
|---|---|---|
| **zero teams enumerated** (a fresh self-hosted install) | the global success row covers it | a global **`ok:true`** heartbeat. ⚠️ *Round 2 H1: an empty successful read means there was nothing to converge, NOT that convergence failed — `ok:false` would manufacture a failure and, being global, would falsely red a team created moments later* |
| **a team created mid-tick** — the wrapper snapshots `teams` once (`lib/access/bootstrap.ts`), so a team created while another converges is absent from the outcomes | the global success row makes its card falsely green | **the team-creation path records its own row.** `lib/admin/teams.ts` already calls `ensureAccessBootstrap` best-effort at creation and records **no** ingest row; it now records that outcome as a team-scoped `access_bootstrap` row, so **every team has a durable first row from the moment it exists** |
| **process death mid-wrapper** | same false green | rows are written **as each team completes**, not after the whole wrapper returns, so completed teams keep theirs. ⚠️ *Round 2 H2 — my "stops masking after one tick" claim was wrong: nothing was written until the wrapper returned, so one hung team delayed every team's row* |

The incremental write is why `ensureAccessBootstrapAllTeams` gains a **per-team outcome callback**
rather than only a richer return value: the return value cannot be recorded until the loop ends, which
is exactly the property round 2 attacked.

⚠️ **The wrapper guards the callback invocation itself** (round 3 M2). A throw from `onOutcome`
*outside* the per-team `try` would abort every remaining team's convergence — observability taking
ingestion down, the exact inverse of `lib/ingest/runs.ts:55-59`'s charter — and *inside* it would be
mislabelled as that team's bootstrap failure and pushed to `failed`. Neither is acceptable: the
callback gets its own guard, and a callback failure is recorded against neither.

**Residual, stated rather than solved:** a team enumerated in a tick that dies before that team's own
turn still has no row for that tick. It self-heals on the next tick, and after the change above a
team's *first* row is ATTEMPTED at creation rather than waiting for a tick. ⚠️ *"Durable first row from
the moment it exists" would be a universal over a best-effort insert (round 3 LOW): the creation insert
is swallowed like every other (`lib/ingest/runs.ts:55-59`), and a team created by direct SQL bypasses
`createTeam` entirely — round 3 verified that every PRODUCTION path routes through it
(`scripts/admin.ts:135`, `docker/bootstrap.mjs:234`).* The **maximum transition window is UNVERIFIED**
— bounded by the tick cadence (§0c) only when nothing hangs.

### 2b.1 A cost this slice INTRODUCES, named rather than discovered later

⚠️ **Round 3 MEDIUM 1, and it contradicts an intent the health module states in its own comment.**
After this slice, the newest `scheduler`-triggered **instance-wide** `access_bootstrap` row freezes at
deploy (591 exist on prod today; none will be added). The staleness beat is
`distinct on (source)` over `team_id = $1 or team_id is null` **and** `trigger='scheduler'`
(`lib/ingest/pipeline-health.ts:366-372`). So a team created AFTER deploy has no `scheduler` row of its
own until its first tick, and is judged against that frozen fossil — **stale, therefore `failing`,
therefore a red banner on a healthy brand-new team until its first scheduler row lands.**

⚠️ **How long that is, corrected (Codex diff review MEDIUM 2).** I first wrote "one tick cadence
(30-86 min)". That is right only because THIS fleet has one team. Teams converge **sequentially**
inside one tick (`lib/access/bootstrap.ts`), and the whole tick is single-flighted with overlapping
ticks **skipped rather than queued** (`lib/ingest/single-flight.ts:39-50`) — so a team enumerated last
waits for a full convergence pass over every team ahead of it, and a single hung team makes the wait
**unbounded**. The honest statement: bounded by **one full convergence pass**, which on this fleet
equals one tick cadence (30-86 min measured, §0c) and on a multi-team fleet is **UNVERIFIED** — the
same window §2b already declines to bound.

That is precisely the case the module intends to exempt: *"A source with rows but no scheduler row yet
(a brand-new team whose first tick hasn't landed …) has no heartbeat to judge, so it is not aged at
all"* (`:394-400`). The fossil defeats the exemption.

**This slice ACCEPTS it and pins it with a criterion (AC13) rather than fixing it**, because the fix is
to the beat query — shared by every leg — and scope creep of exactly that kind is what round 2 blocked.
**AUDITFIX-24** carries it. The cost is bounded, self-healing, and only ever affects a team between its
creation and its first tick; the alternative — keeping a global `scheduler` heartbeat — reintroduces a
masking window for the whole duration of each convergence loop, which is the defect this slice exists
to remove.



### 2c. The `trigger` on both writes is load-bearing — and neither round 1 nor round 2 looked at it

⚠️ **Round 3 (a different model, deliberately) found the axis two Codex rounds never named.** The
staleness clock reads **`trigger = 'scheduler'` rows only**
(`lib/ingest/pipeline-health.ts:366-372`), and the module says why: *"Staleness answers 'is the
scheduler still ticking', and only a `scheduler` row is evidence of that."* So:

| write | trigger | why |
|---|---|---|
| the per-team **tick** row | **`'scheduler'`** | it IS the poller's evidence for that team |
| the **creation** row (`lib/admin/teams.ts`) | **`'api'`** — anything but `'scheduler'` | team creation is not the poller; a `'scheduler'` row here would fake liveness for a team whose tick has never run |

**The first of those would otherwise ship a green test suite and a permanently red production banner.**
If the per-team tick rows carried a non-`scheduler` trigger, this slice stops writing the only
`scheduler`-triggered `access_bootstrap` rows there are (**591 on prod today, all instance-wide**), so
the beat freezes at deploy, every team's leg goes stale ~3h later, and the banner reds forever. The dm
tier **cannot** catch it: a fresh test DB has no `scheduler` rows at all, so `beatAt.get(source)` is
`undefined` and the leg is deliberately *not aged* (`:394-400`). Green by construction, broken in prod.
**AC11 and AC12 assert the trigger values directly**, because no behavioural criterion can.

## 3. Scope

**In:** `lib/ingest/scheduler.ts` (the ledger) · `lib/access/bootstrap.ts` (the per-team outcome
callback) · `lib/admin/teams.ts` (the creation row) · `docs/ARCHITECTURE.md`.

**Out:**
- **The census, `assessAccessHealth`, and the CLI vocabulary — AUDITFIX-23** (§3a).
- **Repair — AUDITFIX-21.** Nothing here deletes an edge.
- **Making `newest` team-aware in general** — the wider, riskier change; per-team rows reach the same
  outcome for this leg without touching the others.
- **`ingest_runs` retention.** ⚠️ *Corrected twice. Round 1 M3 killed my "context_backfill already pays
  this" claim — `backfillAllTeams` is budgeted and defers teams
  (`lib/projects/context/backfill.ts:238-249`), so it does NOT pay row-per-team-per-tick. Round 2 M1
  then killed my arithmetic: an ordinary tick today writes one global row, and after this change it
  writes N scoped rows and no global one, so the **net** delta is `(N − 1) × ticks`, not `N × ticks`.
  **On this one-team fleet the ordinary row count is UNCHANGED**, not one extra per tick.* Fleet-scale
  impact stays unverified; retention remains the pre-existing follow-up in the
  `lib/ingest/pipeline-health.ts` header.

### 3a. The split, and why the ledger goes first

Round 2's HIGH 3: the slice spanned ledger lifecycle, scheduler census and error aggregation, standing
health semantics, and CLI vocabulary — and the ledger **alone** carries creation, snapshot,
partial-write, deployment-transition, global-failure, confirmation, healing and staleness contracts.
AUDITFIX-3's round 2 said the same thing about a nine-concern slice and was right.

**The ledger goes first because the census depends on it**, not merely because it is smaller: a census
finding reported through a masked leg is invisible, which is the entire lesson of §0a. **AUDITFIX-23** carries the census over every `kind='system'` project, `assessAccessHealth`'s inverse
assertion, and the `blockers`/CLI widening. It is filed as a **brain task row** with rounds 1 and 2's
findings written into its description; it has **no `docs/design/` spec yet** — that gets written when
it is built, per this loop's own order. *(Round 3 LOW flagged that my wording implied an in-repo
document.)*

## 4. Acceptance

⚠️ **Two shapes are pre-empted rather than rediscovered**, because AUDITFIX-3 shipped FIVE criteria
that were green while testing nothing: every fixture precondition is asserted, and **every
BOOTSTRAP-fault injector fails reads only** — an injector that also kills the write cannot observe the
damage it exists to catch. *(Scoped to bootstrap faults on purpose: AC10 must fault an `ingest_runs`
INSERT, so a blanket "reads only" rule would make it unimplementable — round 3 M3.)*

⚠️ **Every visibility criterion runs TWO ticks and asserts the CONFIRMED state** (§0b, round 1 B4 and
round 2 B2).

- **AC1 — a per-team failure is LOUD on that team's card, and written EXACTLY ONCE per tick (dm):**
  seed TWO teams, wedge one with a reserved-slug `initiative`, run **two** record sequences, then read
  the shipped consumer: `access_bootstrap` in **`failing`**, `failureClass` **`confirmed`**,
  **`healthy === false`** — **and exactly one scoped `ok:false` row per failing team per tick (two
  total)**. ⚠️ *Round 3 H2: leaving the existing `for (const f of r.failed)` loop in place alongside
  the callback double-writes every failure, so ONE failed tick reaches streak 2 and goes `confirmed` —
  single-failure loudness, undoing BANNERFLAP-1 for this leg. Nothing else in the suite pins the
  failure-row count.*
- **AC2 — the OTHER team stays green (dm):** absent from `failing`, `healthy === true`.
- **AC3 — a HEALED team goes fully green (dm):** from AC1's **confirmed** red state, remove the wedge,
  run one successful tick, assert `ok`, `failureClass === "ok"`, `failingSince === null`, absent from
  `failing`, `healthy === true`.
- **AC4 — an ordinary tick writes NO `team_id is null` row (dm):** two healthy teams ⇒ exactly two
  `access_bootstrap` rows, both team-scoped.
- **AC5 — a FLEET-level failure reds every card, at the confirmed threshold, writing EXACTLY one row per tick (dm):** seed a team by
  **direct `teams` insert** (bypassing `createTeam`, so it genuinely has no scoped row — the prod
  analogue is a pre-slice team at the deploy transition) and **assert it has zero scoped rows first**;
  then fault the `teams` read on **two** ticks; exactly one global `ok:false` row per tick; and
  `getPipelineHealth` for that team reports `failing` + `confirmed` + `healthy === false`.
  ⚠️ *Round 3 M4 — after this slice `createTeam` always attempts a row, so the precondition is
  unconstructible through the normal path and must be stated.*
- **AC6 — ZERO teams writes an `ok:true` heartbeat (dm):** one global row, **`ok: true`**.
- **AC7 — a team created MID-TICK still has a row (dm):** with the tick's snapshot taken before team B
  exists, B nonetheless has an `access_bootstrap` row afterwards, and `getPipelineHealth(B)` reports a
  leg rather than silence.
- **AC8 — the creation row records the outcome it actually got (dm):** when the creation-time
  `ensureAccessBootstrap` **returns** `ok:false`, the row is `ok:false` and names the error.
- **AC8b — and when it THROWS (dm):** with a read fault made to throw, the creation path still records
  an `ok:false` row naming the error. ⚠️ *Round 3 H3 — the obvious implementation puts the record after
  `ensureAccessBootstrap` inside `createTeam`'s existing `try` (`lib/admin/teams.ts:58-63`), so a throw
  skips it; AC8's returned-false fault never exercises that path, and "record only on the non-throw
  path" would pass every other criterion while recreating the zero-row case §2b claims to close — on
  the one path where the creation row is load-bearing.*
- **AC9 — rows are written AS EACH TEAM COMPLETES, asserted MID-FLIGHT (dm):** make team B's
  convergence **block** on a never-resolving read; while the wrapper is still in flight, assert team
  A's row already exists; then release the deferred so the run terminates. ⚠️ *Round 3 B1 — a THROW is
  insufficient and cannot redden mutation 9: the wrapper catches a per-team throw and continues
  (`lib/access/bootstrap.ts:169-171`), so a post-loop recording still writes A's row and the criterion
  goes green. That is the third instance of the wrong-mutation-target class this branch has hit.*
- **AC10 — a swallowed scoped insert self-heals (dm):** with team A's `ingest_runs` insert faulted on
  tick 1 and healthy on tick 2, A's leg reports from tick 2. *`recordIngestRun` returns no insertion
  status (`lib/ingest/runs.ts:59`), so the design must not depend on detecting a lost row.*
- **AC11 — the per-team tick row carries `trigger: 'scheduler'` (dm):** asserted on the row.
  ⚠️ *Round 3 H1 — no behavioural criterion can catch this. A non-`scheduler` trigger passes the whole
  dm suite (a fresh DB has no scheduler rows, so the leg is never aged) and freezes the production beat
  at deploy, reddening every team ~3h later, forever.*
- **AC12 — the creation row does NOT carry `trigger: 'scheduler'` (dm):** asserted on the row.
  *Team creation is not the poller; claiming otherwise fakes liveness for a team whose tick never ran.*
- **AC13 — the fossil-staleness cost is PINNED, not accidental (dm):** seed an aged instance-wide
  `scheduler` row for `access_bootstrap`, create a team, and assert the chosen behaviour — its leg
  reads `stale` until its first tick row lands. ⚠️ *§2b.1 — this criterion exists so the cost is a
  recorded decision with a ticket (AUDITFIX-24), not something a later reader discovers as a bug.*

**Mutation coverage, one per enforcement point, each reddening ITS OWN criterion:**

| # | mutation | must redden |
|---|---|---|
| 1 | write the per-team row only on failure | AC3 |
| 2 | write a global `ok:true` row on ordinary ticks, AFTER the per-team rows | AC4 |
| 3 | write that global success row BEFORE the per-team rows | AC4 |
| 4 | make the global row report success on a fleet-level failure — **`ok` AND `errors` together** | AC5 |
| 5 | skip the global row when zero teams are enumerated | AC6 |
| 6 | write `ok:false` for the zero-teams heartbeat | AC6 |
| 7 | drop the team-creation row | AC7 |
| 8 | hardcode the creation row to `ok:true` | AC8 |
| 8b | record the creation row only on the non-throw path | AC8b |
| 9 | record outcomes after the loop instead of per team | AC9 |
| 10 | keep the old `for (const f of r.failed)` loop alongside the callback | AC1 |
| 11 | give the per-team tick row a non-`scheduler` trigger | AC11 |
| 12 | give the creation row `trigger: 'scheduler'` | AC12 |
| 13 | let a callback throw escape the wrapper's guard | AC9 |
| 14 | write the FLEET row twice per tick | AC5 |

⚠️ **Mutation 4 must change `ok` AND `errors` together, and finding that out cost a SURVIVED run.**
`recordIngestRun` derives `ok: run.ok && errors.length === 0` (`lib/ingest/runs.ts:67`), so flipping
`ok: !globalFailure` to `ok: true` alone is silently corrected by that sibling layer and the row still
lands `ok:false` — the mutation tests nothing. The product is better for the redundancy; the mutation
had to defeat it to say anything about THIS module. Same class as the defence-in-depth masking that has
bitten this repo before.

⚠️ *Mutations 2 and 3 are separate because ordering decides observability, and mutation 10 exists
because a double-write is invisible to every criterion that only asserts `confirmed`. Round 2 found
two mutations pointed at criteria they could not redden and round 3 found a third — the table is
checked against each criterion individually, not assumed.*

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| Losing the global success row makes a team's leg vanish | **silence, which reads as healthy** | AC6 (zero teams), AC7 (created mid-tick), AC9 (per-team writes); §2b names the residual |
| A healed team stays red forever | alarm death | AC3 from a **confirmed** red state; mutation 1 |
| The per-team rows red every team's card | alarm noise, shipped decision reversed | AC2 |
| A fleet-level failure stops reddening | the one case that SHOULD be global | AC5, mutation 4 |
| The creation row lies about what happened | a false green at the moment a team is born | AC8, mutation 8 |
| A non-`scheduler` trigger on the tick row | **green tests, permanently red production banner** | AC11, mutation 11 — §2c |
| A `scheduler` trigger on the creation row | fakes poller liveness for a team that has never ticked | AC12, mutation 12 |
| The old failure loop left in alongside the callback | double-written failures ⇒ single-failure loudness, undoing BANNERFLAP-1 | AC1's per-tick row count, mutation 10 |
| A new team reads stale against the frozen global fossil | a red banner on a healthy brand-new team, ≤ one tick cadence | **accepted and pinned** — §2b.1, AC13, AUDITFIX-24 |
| A callback throw aborts the remaining teams | observability taking ingestion down | §2b's callback guard, mutation 13 |
| Row growth on an unpruned table | net `(N − 1) × ticks`; **zero on this fleet** | §3, and fleet scale marked unverified |

## 6. What this slice does NOT prove

It does not detect a forbidden system-project grant — that is AUDITFIX-23, which this unblocks — and it
does not repair one (AUDITFIX-21). A merge here should be read as *"a wedged team is now audible"*,
nothing more.

## 7. Rounds 1 and 2 — both BLOCKED

| # | finding | outcome |
|---|---|---|
| **R1 B1** | a cheaper ledger design exists; "both halves are required" is false | **ADOPTED** — one source; the extra source and every registry it needed are gone |
| **R1 B2/B3/B4, H1-H5, M1-M4** | census population, census placement, the confirmation threshold, `kind`-blindness, the CLI's `LOCKOUTS`, and three false claims of mine | **ADOPTED** — the threshold and the corrections are here; census/health/CLI moved to **AUDITFIX-23** |
| **R2 B1** | a team created mid-tick, or a process death, leaves a team with NO row — and a missing leg reads as `healthy: true` | **ADOPTED** — the creation row (§2b), per-team incremental writes, **AC7**/**AC9** |
| **R2 B2** | AC5 was unsatisfiable — one failure is `unconfirmed`, so `failing` stays empty | **ADOPTED** — two faulted ticks |
| **R2 B3/B4/B5** | the throw path untested; `assessAccessHealth` could stay two-slug; two mutations could not redden their named criteria | **B3/B4 → AUDITFIX-23**; **B5 ADOPTED** — mutations 2 and 3 split by ordering |
| **R2 H1** | zero teams is not a failure | **ADOPTED** — `ok:true`; **AC6** |
| **R2 H2** | "stops masking after one tick" is wrong — nothing is written until the wrapper returns | **ADOPTED** — per-team writes; the max window is marked unverified |
| **R2 H3** | split | **ADOPTED** — §3a |
| **R2 M1** | the row-growth delta is `(N−1) × ticks`, and **zero** on a one-team fleet | **ADOPTED** — §3 |
| **R2 M2** | three more places still say "lockout" | **→ AUDITFIX-23**, with the widening |

⚠️ **R1 B1 is the same mistake as one slice ago.** On AUDITFIX-3 I asserted *"neither cheap fix works"*
and the third option was in the same file; here I asserted *"both halves are required"* and the third
option was in the same function. A negative universal of mine about design alternatives has now been
wrong twice running. **When I write "the only way" or "both are required", that is a research task, not
a conclusion.**

**Nothing is built. No code exists for this slice.**

## 8. Round 3 — FABLE, and the first different model found the axis two Codex rounds never named

Rounds 1 and 2 were both gpt-5.6-sol. Round 3 went to Fable for the same reason it did on the previous
slice, where the first Fable round found two blockers three Codex rounds had missed. It returned
**BLOCKED**.

| # | finding | re-derived | outcome |
|---|---|---|---|
| **H1** | **`trigger` is load-bearing on both new writes and the spec never mentioned it.** A non-`scheduler` tick row passes the entire dm suite — a fresh test DB has no scheduler rows, so the leg is never aged — while freezing the production beat at deploy and reddening every team ~3h later, forever | **CONFIRMED.** The beat is `trigger='scheduler'` only (`lib/ingest/pipeline-health.ts:366-372`); prod holds **591** such rows for this source, all instance-wide, and this slice stops adding them | **ADOPTED** — new **§2c**, **AC11**/**AC12** assert the trigger values directly, mutations 11 and 12. *The best finding of the round: green by construction, broken in production.* |
| **B1** | AC9's "hang or throw" conflated two fixtures, and the THROW variant cannot redden mutation 9 — the wrapper catches a per-team throw and continues, so a post-loop recording still writes A's row | **CONFIRMED** (`lib/access/bootstrap.ts:169-171`) | **ADOPTED** — AC9 uses a **blocking** fault and asserts A's row **mid-flight**. Third instance on this branch of a mutation aimed at a criterion it cannot redden |
| **H2** | keeping the existing `for (const f of r.failed)` loop alongside the callback double-writes failures, so ONE failed tick reaches streak 2 and goes `confirmed` — single-failure loudness. No criterion pinned the failure-row count | **CONFIRMED** (`lib/ingest/scheduler.ts:316-327`) | **ADOPTED** — AC1 pins exactly one scoped `ok:false` row per failing team per tick; mutation 10 |
| **H3** | a creation-time THROW still leaves a team with zero rows, and AC8's returned-false fault never exercises it | **CONFIRMED** (`lib/admin/teams.ts:58-63`) | **ADOPTED** — **AC8b** + mutation 8b |
| **M1** | the frozen global fossil ages every NEW team into `stale`, contradicting the module's own stated exemption for a brand-new team | **CONFIRMED** (`lib/ingest/pipeline-health.ts:394-400`) | **ACCEPTED AND PINNED** — §2b.1, **AC13**, **AUDITFIX-24**. Fixing it means changing the beat query for every leg, which is the scope creep round 2 blocked |
| **M2** | callback error containment unspecified — a throw outside the per-team `try` aborts every remaining team | **CONFIRMED** | **ADOPTED** — §2b, mutation 13 |
| **M3** | "every fault injector fails reads only" contradicts AC10, which must fault an INSERT | **CONFIRMED** | **ADOPTED** — the rule is scoped to bootstrap-fault injectors |
| **M4** | AC5's precondition is unconstructible via the normal path once `createTeam` always records | **CONFIRMED** | **ADOPTED** — direct-insert fixture, asserted |
| **LOW** | "durable first row from the moment it exists" is a universal over a best-effort insert; four citations had rotted; §3a implied an in-repo spec for AUDITFIX-23 | **CONFIRMED** | **ADOPTED** — all three corrected |
| — | §0a, §2a's case table, §3's `(N−1)×ticks` and one-team invariance, the `FAILURES_TO_CONFIRM` path, deleted-and-recreated teams, and mutations 1-8 individually | **CLEARED with evidence** | recorded so the build does not re-litigate them |

**Nothing is built. No code exists for this slice.**
