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
until `FAILURES_TO_CONFIRM = 2` (`lib/ingest/failure-streak.ts:36`, `lib/ingest/pipeline-health.ts:454`),
and the banner renders only `failing` (`components/admin/pipeline-health-banner.tsx:57`). A criterion
that ran one failed tick and asserted `legs.find(…).ok === false` would pass **while no banner appears
at all**. Every visibility criterion below therefore runs **two** ticks and asserts the confirmed state.

A leg that is **absent** yields `healthy: true` — `getPipelineHealth`'s empty shape is
`{ legs: [], failing: [], healthy: true }` (`lib/ingest/pipeline-health.ts:350`). **A missing leg is
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
(`lib/ingest/leg-ledger.ts:21`); the default-threshold allowlist; the banner's label map; **two** legs
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

**Residual, stated rather than solved:** a team enumerated in a tick that dies before that team's own
turn still has no row for that tick. It self-heals on the next tick, and after the change above a
team's *first* row comes from creation rather than from a tick at all. The **maximum transition
window is UNVERIFIED** — it is bounded by the tick cadence (§0c) only when nothing hangs.

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
finding reported through a masked leg is invisible, which is the entire lesson of §0a. **AUDITFIX-23**
carries the census over every `kind='system'` project, `assessAccessHealth`'s inverse assertion, and
the `blockers`/CLI widening — filed, with round 1's and round 2's findings on each recorded in it.

## 4. Acceptance

⚠️ **Two shapes are pre-empted rather than rediscovered**, because AUDITFIX-3 shipped FIVE criteria
that were green while testing nothing: every fixture precondition is asserted, and every fault injector
fails **reads only** (an injector that also kills the write cannot observe the damage it exists to
catch).

⚠️ **Every visibility criterion runs TWO ticks and asserts the CONFIRMED state** (§0b, round 1 B4 and
round 2 B2).

- **AC1 — a per-team failure is LOUD on that team's card (dm):** seed TWO teams, wedge one with a
  reserved-slug `initiative` (the pre-existing shipped wedge), run **two** record sequences, then read
  the shipped consumer: `getPipelineHealth(wedged)` has `access_bootstrap` in **`failing`**, its
  `failureClass` is **`confirmed`**, and **`healthy === false`**.
- **AC2 — the OTHER team stays green (dm):** `getPipelineHealth(healthy)` — `access_bootstrap` absent
  from `failing`, `healthy === true`. *Without this, reddening every card passes AC1.*
- **AC3 — a HEALED team goes fully green (dm):** from AC1's **confirmed** red state, remove the wedge,
  run one successful tick, and assert `ok`, `failureClass === "ok"`, `failingSince === null`, absent
  from `failing`, and `healthy === true`. ⚠️ *Round 1 H1 — "green after" alone cannot distinguish
  healed from never-visibly-failed, and mutation 1 would survive it.*
- **AC4 — an ordinary tick writes NO `team_id is null` row (dm):** two healthy teams ⇒ exactly two
  `access_bootstrap` rows, both team-scoped. *The global success row is the thing that masks.*
- **AC5 — a FLEET-level failure reds every card, at the confirmed threshold (dm):** with the `teams`
  read faulted on **two** ticks, exactly one global row per tick is written `ok:false`, and
  `getPipelineHealth` for a team **with no row of its own** reports `failing` + `confirmed` +
  `healthy === false`. ⚠️ *Round 2 B2 — my one-tick version was unsatisfiable: a single failure is
  `unconfirmed`, so `failing` stays empty and `healthy` stays true.*
- **AC6 — ZERO teams writes an `ok:true` heartbeat (dm):** on an instance with no teams, one global
  `access_bootstrap` row, **`ok: true`**. ⚠️ *Round 2 H1 — nothing to converge is not a failure, and a
  global `ok:false` would falsely red a team created moments later.*
- **AC7 — a team created MID-TICK still has a row (dm):** with the tick's `teams` snapshot taken before
  team B exists, B nonetheless has an `access_bootstrap` row afterwards — written by the creation path
  — and `getPipelineHealth(B)` therefore reports a leg rather than silence. ⚠️ *Round 2 B1 — without
  this, B has neither a scoped nor a global row, `STREAK_SQL` returns no leg for it, and a missing leg
  reads as `healthy: true` with staleness unable to fire.*
- **AC8 — team creation records the outcome it actually got (dm):** when the creation-time
  `ensureAccessBootstrap` FAILS, the recorded row is `ok:false` and names the error. *A creation row
  that always said `ok:true` would satisfy AC7 while lying.*
- **AC9 — rows are written AS EACH TEAM COMPLETES (dm):** with team A converging and team B's
  convergence made to hang or throw after A's, A's row exists. ⚠️ *Round 2 H2 — writing after the
  wrapper returns means one slow team delays every team's row, and a process death loses all of them.*
- **AC10 — a swallowed scoped insert self-heals (dm):** with team A's row insert faulted on tick 1 and
  healthy on tick 2, A's leg reports from tick 2. *`recordIngestRun` returns no insertion status
  (`lib/ingest/runs.ts:59`), so "no per-team row was written" is not observable to the writer — the
  design must not depend on detecting it.*

**Mutation coverage, one per enforcement point, each reddening ITS OWN criterion:**

| # | mutation | must redden |
|---|---|---|
| 1 | write the per-team row only on failure | AC3 |
| 2 | write a global `ok:true` row on ordinary ticks, AFTER the per-team rows | AC4 |
| 3 | write that global success row BEFORE the per-team rows | AC4 |
| 4 | make the global row's `ok` ignore a fleet-level failure | AC5 |
| 5 | skip the global row when zero teams are enumerated | AC6 |
| 6 | write `ok:false` for the zero-teams heartbeat | AC6 |
| 7 | drop the team-creation row | AC7 |
| 8 | hardcode the creation row to `ok:true` | AC8 |
| 9 | record outcomes after the loop instead of per team | AC9 |

⚠️ *Mutations 2 and 3 are separate because ordering decides observability: a global success row written
BEFORE the per-team rows leaves the team's row newest, so AC1 stays green and only AC4 catches it.
Round 2's BLOCKER 5 found exactly that error in my previous table — two mutations pointed at criteria
they could not redden.*

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| Losing the global success row makes a team's leg vanish | **silence, which reads as healthy** | AC6 (zero teams), AC7 (created mid-tick), AC9 (per-team writes); §2b names the residual |
| A healed team stays red forever | alarm death | AC3 from a **confirmed** red state; mutation 1 |
| The per-team rows red every team's card | alarm noise, shipped decision reversed | AC2 |
| A fleet-level failure stops reddening | the one case that SHOULD be global | AC5, mutation 4 |
| The creation row lies about what happened | a false green at the moment a team is born | AC8, mutation 8 |
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
