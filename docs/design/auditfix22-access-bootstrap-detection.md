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

### 2a. The ledger: per-team rows every tick + a distinct heartbeat source

`runAccessBootstrap` (`lib/ingest/scheduler.ts`) changes in exactly the way `runContextBackfill`
already works:

1. write an `access_bootstrap` row **per team, every tick, on success as well as failure**;
2. move the instance-wide heartbeat to the distinct source **`access_bootstrap_all`**.

**Both halves are required, and the two obvious cheaper fixes are wrong:**

- *Make the global row `ok:false` when any team failed.* This reverses a deliberate shipped decision
  recorded in the code — *"a single instance-wide failed row would have turned every team's admin
  banner red while hiding the cause in meta"* — and on a multi-team fleet it reds every healthy team.
- *Make `newest` prefer the team-scoped row.* Two defects. It changes leg selection for **every**
  source, not just this one; and with failure-only per-team rows it **pins a healed team red forever**,
  because no success row is ever written to supersede the failure. That second one is why the ledger
  half must land before or with the census — a detector whose alarm cannot clear is not a detector.

**Staleness: no map entry, and that is measured rather than assumed.** `access_bootstrap` has no entry
in `STALE_MS_BY_SOURCE`, so it takes the 3h default; `access_bootstrap_all` is written by the same
invocation milliseconds later, so its gaps are identical **by construction** and it inherits the same
default. That is the `context_backfill`/`context_backfill_all` pairing exactly — and that pair's own
comment records the trap: *"It must move with its sibling or the banner keeps flapping."* Since the
divergence is silent, §4 pins the pair with a guard rather than trusting the absence of an entry.

### 2b. The census: converge FIRST, then look

`ensureAccessBootstrap` censuses the two system projects for unsanctioned edges using AUDITFIX-3's
`isSanctionedSystemEdge`, and reports any as a team failure.

⚠️ **It runs AFTER the three sanctioned grants converge, and the ordering is the whole finding.**
AUDITFIX-3's round-2 HIGH 2: `ensureAccessBootstrap` creates its three edges LAST, and returns early on
failure. A census placed before them returns the required failure while a **missing sanctioned edge is
never restored** — the team stays half-wired *because* the detector fired. So: builtins → system
projects → the three grants → census → report.

This is the same shape as the adoption guard AUDITFIX-3 shipped, pointed at the rows adoption never
re-examines: `ensureSystemProject` censuses only on the `source → system` transition, so an
**already-`system`** project is never looked at again (`lib/access/bootstrap.ts`). That is precisely
the population §3b.4 of the AUDITFIX-3 spec called "latent unrevokable state".

**Fails closed:** a census read error is a team failure, never "no forbidden edges".

### 2c. The operator-asks path

`assessAccessHealth` gains the inverse assertion: a system project holding an unsanctioned edge is
reported.

⚠️ **This widens what `blockers` MEANS, and the widening must be deliberate.** Today the field is
documented as *"Hard reasons to refuse — each would cost a human access to content they can see
today"* (`lib/admin/access-health.ts:27-30`) — i.e. lock-OUT. A forbidden grant is the opposite: it is
over-exposure. Filing it under `warnings` would leave `healthy: true`, which is the report-green-while-
broken failure this slice exists to prevent. So `blockers` becomes *"hard reasons to refuse — a human
locked OUT, or a group let IN that the substrate never sanctioned"*, and the doc comment says so.
`healthy` is consumed only by `scripts/admin.ts:427`, so the blast radius is the CLI's output.

## 3. Scope

**In:** `lib/ingest/scheduler.ts` (the ledger) · `lib/access/bootstrap.ts` (the census + its ordering) ·
`lib/admin/access-health.ts` (the inverse assertion) · a staleness-pair guard · `docs/ARCHITECTURE.md`.

**Out:**
- **Repairing** a forbidden edge — AUDITFIX-21. This slice REPORTS; it never deletes. A fail-open
  destructive repair is worse than a reported hole, and that ruling is inherited from AUDITFIX-3 §3.
- **`ingest_runs` retention.** Per-team rows add one row/team/tick, which `context_backfill` already
  pays. The table is unpruned and `scoped` sorts a team's whole history — a real follow-up, already
  recorded in the `lib/ingest/pipeline-health.ts` header, and NOT made materially worse here (one extra source
  at an existing cadence). Named so the next reader does not have to rediscover it.
- **Making `newest` team-aware in general.** §2a explains why that is a wider and separately risky
  change; the distinct-source route reaches the same outcome for this leg without touching the others.

## 4. Acceptance

- **AC1 — a per-team failure is VISIBLE to its own team's health card (dm):** seed TWO teams, wedge one
  (a reserved-slug `initiative`, the shipped pre-existing wedge), run the scheduler's record sequence,
  then read the **shipped consumer** — `getPipelineHealth(wedgedTeam)` reports `access_bootstrap`
  failing. *This is the criterion the whole slice exists for, and it must go through the real reader,
  not the rows.*
- **AC2 — and the OTHER team stays healthy (dm):** `getPipelineHealth(healthyTeam)` reports
  `access_bootstrap` ok. *Without this, reddening every card would pass AC1.*
- **AC3 — a HEALED team goes green again (dm):** with the wedge removed and one further tick,
  `getPipelineHealth(previouslyWedged)` reports ok. *The failure-only ledger cannot express this — an
  alarm that cannot clear is why the "prefer the team row" fix was rejected (§2a).*
- **AC4 — the instance-wide heartbeat is under `access_bootstrap_all` (dm):** a tick writes exactly one
  `team_id is null` row and it carries that source; no `team_id is null` row is written under
  `access_bootstrap`. *The mechanism AC1 depends on.*
- **AC5 — the heartbeat still reports a GLOBAL failure (dm):** with the `teams` read faulted,
  `access_bootstrap_all` is `ok:false`. *The existing `teamId: "*"` contract must survive the move.*
- **AC6 — the staleness pair cannot silently diverge (unit):** the effective threshold for
  `access_bootstrap` and `access_bootstrap_all` is equal, whatever it is. *The
  `context_backfill_all` comment records this exact trap; an absent entry today is not a guarantee
  tomorrow.*
- **AC7 — the scheduled census FINDS a forbidden edge on an already-system project (dm):** plant one
  out of band on a `kind='system'` project, run `ensureAccessBootstrapAllTeams`, and that team comes
  back failed with the edge named. *The population adoption never re-examines.*
- **AC8 — the census runs AFTER convergence (dm):** seed a team with BOTH a forbidden edge and a
  MISSING sanctioned edge; the call fails loudly **and** the sanctioned edge is restored. *AUDITFIX-3
  round 2 HIGH 2 — a census placed first returns the required failure while leaving the team
  half-wired.*
- **AC9 — the census FAILS CLOSED (dm):** with the edge read faulted, the team is reported failed;
  it never reports "no forbidden edges" from a read it could not complete.
- **AC10 — a clean team is NOT reported (dm):** `ensureAccessBootstrapAllTeams` returns it unfailed.
  *Without this, a census that always failed would pass AC7, AC8 and AC9.*
- **AC11 — `assessAccessHealth` reports the forbidden edge and goes `healthy:false` (dm):** with the
  edge planted, the blocker names the project and the group.
- **AC12 — `assessAccessHealth` stays healthy on a clean team (dm):** the inverse control for AC11.
- **AC13 — `assessAccessHealth` FAILS CLOSED (dm):** with its edge read faulted, it does not certify
  `healthy:true`.

**Mutation coverage, one per enforcement point, each reddening ITS OWN criterion:**

| # | mutation | must redden |
|---|---|---|
| 1 | write the per-team row only on failure (revert the success half) | AC3 |
| 2 | keep the heartbeat under `access_bootstrap` | AC1 |
| 3 | make the heartbeat `ok` ignore the `teams`-read failure | AC5 |
| 4 | move the census BEFORE the three sanctioned grants | AC8 |
| 5 | delete the census's unsanctioned-edge check | AC7 |
| 6 | swallow the census read error | AC9 |
| 7 | delete `assessAccessHealth`'s new blocker | AC11 |
| 8 | swallow `assessAccessHealth`'s edge-read error | AC13 |
| 9 | give `access_bootstrap_all` its own staleness override | AC6 |

⚠️ **Every fixture precondition is asserted, and every fault injector fails READS ONLY.** Five criteria
shipped vacuous on AUDITFIX-3 — an unasserted `createGroup`, a slug UPDATE that lost to a unique
constraint, and an injector that killed the write it existed to catch. None was a weak guard; all were
tests. The same two shapes are pre-empted here rather than rediscovered.

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The per-team rows red every team's card | alarm noise, and the shipped decision reversed | AC2 pins another team staying green |
| A healed team stays red forever | alarm death — the alarm that cannot clear | AC3, mutation 1 |
| The census fires before convergence and leaves a team half-wired | the detector CAUSES the damage | AC8, mutation 4 |
| The staleness pair diverges later | the banner flaps on one leg of a pair | AC6, mutation 9 |
| `blockers` widening surprises a consumer | the CLI's verdict changes meaning | §2c — one consumer (`scripts/admin.ts:427`), doc comment updated in the same change |
| Row growth on an unpruned table | `ingest_runs` grows one row/team/tick faster | §3 — `context_backfill` already pays exactly this; retention is a named, pre-existing follow-up |

## 6. What this slice does NOT prove

It does not prove a forbidden edge can be REPAIRED — `revokeProjectFromGroup` still refuses every
`kind='system'` revocation, so a detected edge remains raw-SQL-only until AUDITFIX-21. A merge here
should be read as *"you will now be told"*, not *"it is now fixable"*.

**Nothing is built. No code exists for this slice.**
