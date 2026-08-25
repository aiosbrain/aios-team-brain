# The staleness beat must read the partition its poller actually writes — AUDITFIX-24

**Status:** spec, rounds 1 and 2 folded — **four model passes, and the two models disagreed on the
central question in BOTH rounds** (round 1: Codex BLOCKED / Fable CLEAR-WITH-CONDITIONS; round 2:
Codex BLOCKED "the refusal FALLS" / Fable CLEAR-WITH-CONDITIONS "the refusal STANDS"). Round 2 is
where I withdrew a refusal I had argued in writing, and where the guard I had just added turned out
not to catch its own motivating mutation. No code written. Filed 2026-08-23 out of
AUDITFIX-22's spec round 3, and PINNED as an accepted cost by that slice's AC13 rather than fixed there.

**Build with:** opus / high — it changes the input to a LOUD banner for every leg at once, and the
failure direction on both sides is bad: cry wolf on a healthy team, or go silent on a dead poller.

**Deps:** AUDITFIX-22 (merged, deployed) created the live instance of this defect.

---

## What and why

**What:** `getPipelineHealth` resolves a leg's staleness clock with

```sql
select distinct on (source) source, finished_at
  from ingest_runs
 where (team_id = $1 or team_id is null) and trigger = 'scheduler'
 order by source, finished_at desc
```

(`lib/ingest/pipeline-health.ts:366-372`) — one row per source, from **whichever partition is newer**,
team-scoped or instance-wide. Ten lines below, the module states an exemption it does not implement:

> *"A source with rows but no scheduler row yet (a brand-new team whose first tick hasn't landed, or
> an on-demand-only leg) has no heartbeat to judge, so it is not aged at all"* — `:397-400`

A team with no scheduler row **of its own** still resolves a clock, from an instance-wide row that
says nothing about it.

**Why it is live now:** AUDITFIX-22 stopped `access_bootstrap` writing an instance-wide row on
ordinary ticks (`lib/ingest/access-bootstrap-leg.ts:69-92` writes one only on a fleet-level failure,
`teams === 0`, or a throw). The newest instance-wide row therefore **froze at deploy**. A team created
after that deploy is judged against a fossil, reads `stale`, lands in `failing`, and turns the admin
banner **red on a healthy brand-new team** (`stale` is OR'd into `failing`/`healthy`,
`pipeline-health.ts:454`; rendered at `app/t/[team]/page.tsx:201` and
`components/admin/pipeline-health-banner.tsx:70`).

## 0. Terrain, measured before designing

### 0a. Production, read-only, 2026-08-25

Every `trigger='scheduler'` row, grouped by source and partition:

| source | instance-wide rows | team-scoped rows | newest instance-wide | newest team-scoped |
|---|---:|---:|---|---|
| `access_bootstrap` | 594 | 90 | **2026-08-23 18:05** | 2026-08-25 15:29 |
| `auth_cleanup` | 46 | 0 | 2026-08-25 13:54 | — |
| `auto_flip` | 51 | 0 | 2026-08-19 01:53 | — |
| `context_backfill` | 0 | 648 | — | 2026-08-25 15:29 |
| `context_backfill_all` | 648 | 0 | 2026-08-25 15:29 | — |
| `dense` | 636 | 0 | 2026-08-25 10:24 | — |
| `doc_task_infer` | 0 | 52 | — | 2026-08-25 12:24 |
| `github` | 2569 | 0 | 2026-08-25 15:29 | — |
| `graph_project` | 995 | 0 | 2026-08-25 14:53 | — |
| `linear` | 2898 | 0 | 2026-08-25 15:23 | — |
| `linear_inbound` | 2468 | 0 | 2026-08-25 15:23 | — |
| `meeting_notes` | 0 | 1885 | — | 2026-08-25 15:30 |
| `plane` | 1059 | 0 | 2026-07-21 09:01 | — |
| `slack` | 2920 | 0 | 2026-08-25 15:23 | — |

**The fossil is row one**, and the transition is visible to the day:

| day | `access_bootstrap` instance-wide | team-scoped |
|---|---:|---:|
| 2026-08-21 | 51 | 0 |
| 2026-08-22 | 49 | 0 |
| 2026-08-23 (deploy) | 38 | 11 |
| 2026-08-24 | **0** | 48 |
| 2026-08-25 | **0** | 32 |

**Since the AUDITFIX-22 deploy the instance-wide `access_bootstrap` clock has not moved at all** — so
on THIS fleet, a team with no scheduler row of its own reads `stale` whether the scheduler is alive or
dead. ⚠️ *That is a fact about a NON-EMPTY fleet, and round 2 caught me generalising it into an
invariant: `access-bootstrap-leg.ts:70` still writes an `ok:true` instance-wide row every tick while
`r.teams === 0`, so on a fresh install the clock is live until the first team exists. §5a is where
that correction lands, and it is what withdrew a refusal.*

**Not measured, and it matters:** this fleet has **one team** (`aios`, created 2026-06-16, 2,675
scheduler rows of its own), so the defect is **latent here** and would fire on the next team created,
or on any self-hosted instance that adds a team after upgrading. The table is evidence about which
partition each writer uses, not about multi-team behaviour.

### 0b. Which partition each POLLER writes — the property that actually matters

⚠️ *Round 1 (both models) corrected the framing: the question is not "which partition does this
source's writer use" but "which partition does its **`trigger='scheduler'`** writer use". Several
sources write team-scoped rows and have no poller beat at all, and `graph_project`/the connectors
have team-scoped NON-scheduler paths whose scheduler beat is instance-wide.*

- **team beat:** `access_bootstrap` (`access-bootstrap-leg.ts:53-61`), `context_backfill`
  (`scheduler.ts:346-353`), `meeting_notes` (`scheduler.ts:447-465`), `doc_task_infer`
  (`lib/dashboard/doc-task-infer-run.ts:509-511`).
- **instance-wide beat:** `context_backfill_all` (`scheduler.ts:393-395, 415-419`), `dense`,
  `linear_inbound` (`scheduler.ts:165-179`), `auth_cleanup` (`scheduler.ts:276-287`), the four
  connectors via `runImport`'s `label` (`scheduler.ts:229-243`), `pret3_sweep`, `pret4_materialize`,
  `graph_project` (`lib/graph/scheduler.ts:66`), `graph_health`
  (`lib/graph/extraction-alert.ts:373,517,529,544`).
- **NO TRUSTWORTHY poller clock** (`none`) — ⚠️ *round 2 corrected the name: "has no scheduler row at
  all" is FALSE for two of these, and a rule stated that way would fail on current code.* `arcs` —
  deliberately `trigger:"api"`, and its comment says why (`lib/graph/arcs.ts:1254-1256`: *"`scheduler`
  rows are read as poller-heartbeat evidence in pipeline-health; this one is not that"*) · `llm`
  (`trigger:"api"`, and not a pipeline leg at all) · `pm_sync` — its writer takes the trigger as a
  PARAMETER (`lib/pm-sync/runs.ts:76,81`) and every caller today passes `api`/`manual`/`cli`, so
  nothing statically forbids a `scheduler` row · `scan` — the trigger comes from a **client header**
  (`app/api/v1/codebases/route.ts:10,48-49`), so an authenticated caller can *claim* `scheduler` and
  its rows carry `teamId: auth.teamId`. Both have `null` thresholds today, and scope `none` is what
  keeps a spoofed or future scheduler row from becoming anyone's clock.

### 0c. `access_bootstrap` writes BOTH partitions, and that stays true

Team rows on every ordinary pass; instance-wide rows **only** on a fleet-level failure, `teams === 0`,
or a throw. That asymmetry is what AUDITFIX-22 shipped, and its AC5
(`test/datamechanics/access-bootstrap-ledger.datamechanics.test.ts:209`) pins the consequence: a
fleet-level failure reds a team with **no row of its own**, reaching `confirmed` at two ticks.

**That signal travels the VERDICT channel, not the beat.** `STREAK_SQL`'s `newest` CTE picks the leg
from whichever partition holds the newest row (`pipeline-health.ts:321-325`), and on a fleet-failure
tick no per-team rows are written at all — so the fleet row IS the leg. Nothing in this slice touches
that. *(Round 1, Fable: verified. Round 1, Codex: raised as a Critical; re-derived and answered in
§5a.)*

## 1. The rule

> **A leg's staleness clock is read from the partition its POLLER writes, and never from the other
> one. A team-beat leg with no scheduler row for THIS team resolves no clock, and is therefore not
> aged — which is the exemption the module already claims.**

## 2. The design

### 2a. The beat scope is DECLARED beside the threshold question, and CROSS-CHECKED against the writers

`lib/ingest/leg-ledger.ts` exists to make "did anyone think about this leg?" a build failure. The beat
scope is the same question shape with the same failure mode when nobody answers it, so it lives in the
same file:

```ts
export type BeatScope = "team" | "global" | "none";
export const BEAT_SCOPE_BY_SOURCE: Readonly<Record<string, BeatScope>> = { … };
```

Three values, not two — `none` is `arcs`/`llm`/`pm_sync`/`scan`, which never write a poller row at
all. Calling them `team` would be a false statement about the code that happens to be inert.

⚠️ **A declared map that nothing checks against the writers is the "call site nothing pins" class this
repo keeps re-hitting** (Fable HIGH; Codex reached the same place through AC7). Concretely: flip one
`teamId: t.id` to `teamId: null` at `scheduler.ts:449` and `meeting_notes` silently stops aging while
every criterion here stays green, because the KEY SET is intact. So `test/guards/ingest-leg-ledger.test.ts`
gains a cross-check on the scan it already runs (`:36-54` parses `recordIngestRun` argument lists):

- **EVERY** attributable `trigger:"scheduler"` call site of a `team` source passes a non-null
  `teamId`; **every** such site of a `global` source passes `null` or nothing.
  ⚠️ *Round 2 killed the "≥1" form both models had let through in round 1: `meeting_notes` has TWO
  scheduler sites (success `scheduler.ts:447`, failure `:458`), so flipping the ONE the spec names as
  its motivating edit leaves the other satisfying an existential rule — mutation 8, the mutation this
  spec calls the one that matters most, survived its own guard.*
- **The parsing semantics are load-bearing and are part of the rule, not the implementation:**
  `teamId: null` counts as passing NONE (`context_backfill_all`, `pret3_sweep`, `pret4_materialize`
  all pass it explicitly, and a key-presence test would fail all three AND let mutation 8 through,
  since the mutant writes `teamId: null`); an absent key counts as none; the shorthand `teamId,`
  counts as passing one (`doc-task-infer-run.ts:510`).
- a `none` source has no attributable `trigger:"scheduler"` call site — and, separately, **may not
  carry a finite `STALE_MS_BY_SOURCE` threshold**, because a finite bar on a leg that can never
  resolve a clock is silence by construction.
- **ENUMERATED EXEMPTIONS, because a universal rule must say what it cannot see:**
  (i) the four connectors, whose only scheduler writer is `source: label` (`scheduler.ts:229-243`)
  and is deliberately unresolvable to the scan — a universal rule would otherwise RED ON CLEAN CODE;
  (ii) `access_bootstrap`, declared `team`, which legitimately also writes instance-wide rows on the
  fleet-failure/`teams===0`/throw paths (§0c) — the exception is only needed under the universal
  rule, which is itself evidence the universal rule is the real one.
- **And the scan gets one upgrade it needs anyway:** `recordIngestRun` sites with no parseable
  `source:` are currently `continue`d silently (`ingest-leg-ledger.test.ts:81`), which hides
  `graph_project`'s SUCCESS-path scheduler site behind `projectionRunInput` (`lib/graph/scheduler.ts:66`)
  — its `global` claim is verified today only by the catch-path site, a coincidence. Those sites move
  into `unresolved`, where the existing guard already demands an accounting.

### 2b. The beat query returns BOTH partitions; the resolver picks one

```sql
select distinct on (source, (team_id is null)) source, (team_id is null) as is_global, finished_at
  from ingest_runs
 where (team_id = $1 or team_id is null) and trigger = 'scheduler'
 order by source, (team_id is null), finished_at desc
```

At most two rows per source. The resolver takes the one the declared scope names, keyed by
`(source, is_global)` — **not** by `source` alone, which would let the two rows overwrite each other
(Postgres orders `is_global` false-then-true, so the global row would win and the fix would be
undone silently).

This does NOT read other teams' rows: the scope comes from the ledger, never from whether some other
team happens to have a row.

### 2c. `resolveBeatClock` is PURE, and that is where the fail-open lives

```ts
resolveBeatClock({ beats, source, legFinishedAt }): string | undefined
```

- `beats === null` (the beat read FAILED) → `legFinishedAt`, exactly as today. Fail open: never invent
  staleness from missing data.
- `team` → the team-partition row, else **`undefined`** (= not aged).
- `global` → the instance-wide row, else `undefined`.
- `none` → `undefined`, always.

Pure, so the fail-open and every scope are unit-tier criteria rather than facts only a database can
state (CLAUDE.md §4).

### 2d. An UNDECLARED source resolves from the instance-wide partition

Sources exist in `ingest_runs` that no call site writes any more — `auto_flip` is retired (PRET-6) and
all 51 of its prod rows are instance-wide.

⚠️ *Round 1 killed my first argument for this. I wrote that the guard makes "undeclared" mean
"retired", never "new". **It does not:** the scan resolves literals and named constants and flags
unresolvable `source:` expressions, but a connector added as `runImport(db, "notion", …)`
(`scheduler.ts:229-243`) introduces a new source value with no new `recordIngestRun` site and no new
unresolved expression — the guard stays green (Codex HIGH; Fable independently narrowed the same claim
from the other side). And there is **no** safe default: `global` silences an undeclared team poller,
`team` silences an undeclared global one.*

The default is `global` because it is the LOUD direction for the sources that actually reach it today
(every undeclared source in prod is instance-wide), and because the cross-check in §2a is what
actually carries the completeness burden. Stated as defense-in-depth, not as a guarantee.

## 3. Scope

**In:** `lib/ingest/leg-ledger.ts` (the scope map) · `lib/ingest/pipeline-health.ts` (the beat query +
`resolveBeatClock`) · `test/guards/ingest-leg-ledger.test.ts` (the scope must be answered AND match
the writers) · **`lib/ingest/access-bootstrap-leg.ts` — the new unconditional instance-wide
`access_bootstrap_all` heartbeat (§5a), plus its ledger + threshold entries** · new unit + dm
criteria · **converting AUDITFIX-22's AC13** · **correcting a false
comment in `test/pipeline-health-staleness.test.ts:36-37`**, which still says *"access_bootstrap
writes an unconditional instance-wide heartbeat"* — untrue since AUDITFIX-22 and measured at 0
instance-wide rows/day in §0a, and it is the exact sentence this slice's model contradicts.

**Out:**
- **Thresholds.** `STALE_MS_BY_SOURCE` is untouched. This changes WHICH clock is read, never the bar.
- **The verdict/streak read.** `STREAK_SQL` keeps choosing the leg from the newest partition. ⚠️ *My
  round-0 claim that the beat was "the last read in this file that mixes partitions" was FALSE —
  the `newest` CTE mixes them too (`:321-325`), deliberately, and AUDITFIX-22's AC5 depends on it.*
- **Retention / a bounded window** on `ingest_runs`; the connector-orphan suppression; BANNERFLAP
  classification; the synthetic `graph_extract` leg.

⚠️ **AC13 IS A CONTRACT, NOT AN OBSTACLE.** `access-bootstrap-ledger…:367` asserts `stale === true`
for a brand-new team against a seeded fossil, with a comment naming AUDITFIX-24 as its fix. Flipping
the assertion while keeping the fossil seeding, the leg-exists and the `ok:true` assertions is the
deliberate act this slice exists for. Deleting it is not — it is the only place the fossil scenario is
constructed. *(Both reviewers verified nothing else that test pins is lost.)*

## 4. Acceptance

- **AC1 — a brand-new team is NOT stale on a team-beat leg despite an aged instance-wide row (dm):**
  seed an aged `team_id is null` `access_bootstrap` scheduler row, create a team, read
  `getPipelineHealth` — the leg exists, is `ok`, and `stale === false`. *AUDITFIX-22's AC13 with its
  assertion flipped and its fossil seeding kept byte-for-byte.*
- **AC1b — the exemption holds even when the leg's OWN newest row is old (dm):** as AC1, but the
  team's only `access_bootstrap` row (its creation row, `trigger` ≠ `scheduler`) is aged past the bar
  — still `stale === false`. *Without this, an implementation that falls back to the leg's own row
  passes AC1, because on AC1's fixture that row is fresh. Mutation 4 is exactly that implementation.*
- **AC2 — the team's OWN aged scheduler row still ages it (dm):** `stale === true`. *The fix must not
  delete staleness for team-beat legs; a dead per-team poller is what it is for.*
- **AC2b — a FRESHER instance-wide row does NOT rescue an aged team beat (dm):** aged team-scoped
  scheduler row + a recent instance-wide one → still `stale === true`. *The opposite direction of AC1,
  and the only criterion that reddens "newest partition wins" in the direction that HIDES a failure.
  Round 1 (Codex) found it missing.*
- **AC3 — a fresh team row wins over an aged fossil (dm):** both present, team row recent →
  `stale === false`. *Also the only criterion that reddens a resolver keyed by `source` alone (§2b).*
- **AC4 — an instance-wide leg still ages from instance-wide rows (dm):** an aged
  `context_backfill_all` scheduler row with no team row → `stale === true`; replaced by a recent one →
  `false`. *`context_backfill_all` because it is global-only, has a finite (6h) threshold (`pipeline-health.ts:95`), and is not
  connector-suppressed.*
- **AC5 — a team-beat leg is judged per TEAM (dm):** two teams; A has a recent scheduler row, B has
  none. B not stale, A not stale; then age A's row — **A is stale and B is explicitly asserted NOT
  stale.** *That last assertion is load-bearing: without it mutation 12 survives, because under it B
  borrows A's FRESH row and the first two clauses still pass (Fable MEDIUM).*
- **AC6 — the fail-open path is unchanged (unit):** `resolveBeatClock` with `beats === null` returns
  the leg's own `finished_at`, for every scope.
- **AC6b — and `getPipelineHealth` actually USES it when the beat query fails (dm):** with the beat
  read faulted, a leg whose own newest row is aged still reports `stale === true`. ⚠️ *Round 2: AC6
  tests the pure helper only, and an implementation can keep the helper correct while the call path
  bypasses it or hands it `undefined` — AC1–AC5 all use SUCCEEDING beat reads, so they stay green.
  This is the criterion that pins the wire, not the function.*
- **AC7 — every ledger source declares a beat scope AND the declaration matches its writers (unit
  guard):** key-set parity, plus the §2a cross-check. *Parity alone proves nothing about any scope
  VALUE — a wrong value for `auth_cleanup` would pass it and lose a 26h alarm (Codex HIGH).*
- **AC8 — `none` may not carry a finite threshold (unit guard):** a `none` source with a number in
  `STALE_MS_BY_SOURCE` fails the build. *A finite bar on a leg that can never resolve a clock is
  silence by construction.*
- **AC10 — the instance-wide heartbeat is written on EVERY tick, whatever the fleet did (dm):**
  `runAccessBootstrapLeg` writes exactly one `access_bootstrap_all` instance-wide scheduler row per
  tick — on a healthy multi-team pass, on a fleet-level failure, and on a throw. *Exactly one, not
  "at least one": two rows in one tick would reach the BANNERFLAP confirmation threshold after a
  single blip, which is the trap AUDITFIX-22's AC1 pins per team.*
- **AC11 — and AUDITFIX-22's contracts survive it (dm):** an ordinary tick still writes NO
  `team_id is null` row for source **`access_bootstrap`** (its AC4), and a fleet-level failure still
  reds a team with no row of its own at the confirmed threshold (its AC5). *Both shipped criteria
  must pass UNMODIFIED — the new source must not become a second way to write the old one.*
- **AC12 — a brand-new team on a dead scheduler is aged by the heartbeat at the 3h bar (dm):** no
  team-scoped rows, an aged `access_bootstrap_all` instance-wide row → that leg is `stale`. *This is
  the criterion §5a exists for: the silent corner, closed and pinned.*
- **AC9 — an undeclared source resolves from the instance-wide partition (unit):** `resolveBeatClock`
  for `auto_flip` reads the global row and ignores a team-scoped one. ⚠️ *Resolver-level only: no
  ledger-absent source has a finite threshold today, so this has no product observable, and saying so
  is the point (Fable LOW, Codex HIGH — AC8 in round 0 was offered as safety evidence and is not).*

| # | mutation | must redden |
|---|---|---|
| 1 | declare `access_bootstrap` as `global` | AC1 |
| 2 | restore the shipped `distinct on (source)` beat query | AC1 |
| 3 | team scope falls back to the global row when the team has none | AC1 |
| 4 | team scope falls back to the leg's own `finished_at` when the team has none | **AC1b only** |
| 5 | global scope reads the team partition | AC4 |
| 6 | key the resolver map by `source` instead of `(source, is_global)` | **AC3** |
| 7 | drop one source from `BEAT_SCOPE_BY_SOURCE` | AC7 (parity half) |
| 8 | flip `meeting_notes`' writer to `teamId: null`, leaving its scope `team` | **AC7 (cross-check half)** |
| 9 | give a `none` source a finite threshold | AC8 |
| 10 | `beats === null` resolves `undefined` instead of the leg's own row | AC6 |
| 11 | the undeclared default becomes `team` | AC9 |
| 12 | resolve the team partition from ANY team's row (drop `team_id = $1`) | **AC5's B-side assertion** |
| 13 | keep the global row as the clock when a team row exists but is older | AC2b |
| 14 | team scope always resolves `undefined`, even when the team HAS a scheduler row | **AC2** |
| 15 | keep `resolveBeatClock` correct but bypass it in `getPipelineHealth` when the beat read fails | **AC6b** |
| 16 | write the `access_bootstrap_all` heartbeat only when the fleet pass succeeds | AC10 |
| 17 | write the heartbeat under source `access_bootstrap` instead of `access_bootstrap_all` | AC11 (AUDITFIX-22's AC4) |
| 18 | write a team-beat scheduler site as `teamId: t.id ?? null` — the reviewer's own bypass | **AC7 cross-check** (ambiguity is refused, not guessed) |
| 19 | give a scheduler site a non-literal `trigger` | AC7's unresolved accounting |
| 20 | mirror the fleet failure onto the heartbeat | **AC10c** (one failure, one broken leg) |

⚠️ **Mutations 4, 8, 12, 13, 14 and 15 all exist because writing this table found the criteria
missing.** Mutation 4 was the round-0 catch (AC1 cannot see it). Mutation 8 is a real future edit that
nothing could redden before §2a's cross-check — and round 2 then proved the cross-check as first
written could not redden it either. Mutation 15 is round 2's: a helper that is right and a call path
that ignores it.

⚠️ **WHICH CRITERIA ARE RED-FIRST, stated because it is easy to miscount.** Genuinely red against the
shipped code: **AC1, AC1b, AC2b, the AC13 flip**, and **AC10/AC12** (the heartbeat does not exist).
**AC2, AC4, AC5's B-side and AC6 are GREEN pre-fix** — they are regression pins and mutation-killers,
which is legitimate, but they are not evidence the fix does anything (Fable, round 2).

## 4b. The diff round — both models, and they split again

**Fable: CLEAR-WITH-CONDITIONS. Codex: BLOCKED.** Every condition is folded.

| finding | who | outcome |
|---|---|---|
| The guard GUESSES: `passesTeamId` treated everything except the literal `null` as team-scoped, so `teamId: undefined` and `teamId: x ?? null` read team-scoped while the writer persists NULL. And `trigger:` matched only an exact single-line literal, so a constant-trigger site left `schedulerSites` silently | Codex (HIGH), Fable (LOW, same residual) | **FOLDED** — the partition is TRI-STATE now (`team`/`global`/`ambiguous`) and ambiguity FAILS rather than resolving to the convenient answer; a non-literal trigger goes to `unresolved`. Mutations 18 and 19. The claim in §2a is narrowed to what a text scan can attribute |
| A commented-out `recordIngestRun(...)` was parsed as a live wrapper site, so a deleted real call could leave its exemption apparently occupied | Codex (HIGH) | **FOLDED** — comments are stripped before scanning. Verified after: all five `WRAPPER_RUN_SITES` files still hold a REAL site, so no entry went stale |
| The heartbeat DOUBLE-COUNTS: on a fleet failure it and `access_bootstrap` both confirm, so one failed teams-read reads as "2 ingestion legs are broken" — the exact class that put `llm` in `NOT_PIPELINE_LEGS` | Codex (MEDIUM) | **FOLDED** — the heartbeat asserts LIVENESS (`ok: true`, outcome in `meta.fleetOk`); the failure stays on `access_bootstrap`, where AUDITFIX-22's AC5 reads it. New AC10c pins the whole `failing` SET, which no criterion did |
| The surviving `distinct on (source)` mutant marks a real hole: no criterion has a GLOBAL-scope leg with rows in BOTH partitions | Fable (MEDIUM) | **FOLDED** — AC4b, and the mutant now reddens AC4b and only AC4b |
| **The false sentence had FOUR live copies.** I corrected the one the spec cited and never grepped for the rest — two more in the module I was editing (`pipeline-health.ts:129`, `:304`) and, found by the grep the review prompted, a third in `failure-streak.ts:83` that had already been corrected once and left a different false clause standing | Fable (MEDIUM ×2) | **FOLDED** — all four, plus `ARCHITECTURE.md:96`, which still recorded the fossil as an accepted cost and cited a criterion this diff inverts |
| Red-first accounting omits AC6b, and it is red for an INCIDENTAL reason (its fault keys on `is_global`, absent pre-fix) | Fable (LOW) | **FOLDED** — the dm header says so |
| `heartbeatRows` sliced an unordered select | Fable (LOW) | **FOLDED** — ordered by `id` |

**Verified clean by both:** the SQL is newest-per-partition with no planner surprise; `is_global`
arrives as a JS boolean (the pool overrides only date OIDs); the two `undefined`s stay distinct
through the call site; the heartbeat cannot double-write (`recordIngestRun` never throws, so the catch
path is reachable only before the success-path write); AUDITFIX-22's AC4/AC5 and the converted AC13
are intact; `withFailingBeatRead` really intercepts, and `is_global` selects only the beat query.

**Both models also confirmed my two mutation MISFIRE diagnoses** — `distinct on (source)` alone
degrades to "prefer the team partition" because the ORDER BY still leads on the boolean, and dropping
`team_id = $1` left `$1` unbound so the injected fault was "every beat read errors", not "reads any
team's row".

⚠️ **RESIDUAL, stated rather than implied away:** a scheduler call site built through a WRAPPER
(`lib/graph/scheduler.ts` is one, for `graph_project`'s success path) escapes the cross-check
entirely — `WRAPPER_RUN_SITES` documents what each writes, and that prose is not enforced. All five
reasons were verified TRUE against their code during this round; nothing pins them. An AST-based scan
would close it and is not in this slice.

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| A dead per-team poller stops being reported | SILENCE — the worse direction | AC2 + AC5; the exemption is only "never once ticked", and one landed row arms the clock permanently |
| A fresher global row hides an aged team beat | silence | AC2b, mutation 13 |
| A global leg stops being aged | silence | AC4, mutation 5 |
| A declared scope drifts from its writer | silence, invisible to every other criterion | §2a cross-check, mutation 8 |
| A `none` leg gets a finite threshold later | silence by construction | AC8, mutation 9 |
| Over-correction: deleting AC13 instead of converting it | loss of the only fossil fixture | §3 |
| A never-ticked team on a DEAD scheduler | detection moves from 3h to 6h | §5a — argued, measured, and refused |

### 5a. The regression I tried to refuse, and why I am now fixing it instead

⚠️ **Round 1 (Codex) BLOCKED on this. Round 2 I argued a refusal. Round 2's re-review split again —
Codex: the refusal FALLS; Fable: it STANDS — and the refusal is now WITHDRAWN.** The argument is kept
because the evidence that killed it is worth more than the conclusion.

**What I claimed.** (a) Measured on prod, instance-wide `access_bootstrap` scheduler rows went 51/day
to **0/day** at the AUDITFIX-22 deploy, so for a team with no rows of its own that clock is aged
whether the scheduler is alive or dead — a lamp wired on, not a report. (b) `context_backfill_all` is
an unconditional instance-wide heartbeat at a 6h bar, so the degradation is 3h→6h and never silence.

**What was wrong with (a) — and BOTH models found it independently.** `access-bootstrap-leg.ts:70`
writes an `ok:true` instance-wide row when `r.teams === 0`. So on a **fresh self-hosted install** the
instance-wide clock is live every tick until the first team is created — which is exactly the
population most likely to meet this defect. My measurement generalised ONE non-empty fleet into an
invariant. It holds for "any team created after the fleet's first team"; it is false for the first.

**What was wrong with (b).** "Unconditional per-tick" is contradicted by this file's own measurement:
`pipeline-health.ts:40-52` records `context_backfill_all` writing ZERO rows across a 4.85h truncation
window **while the scheduler was alive**, and states these legs' age means "last time a tick got this
far", not "last time the poller ran". `runContextBackfill` is stage 7 of the tick and
`runAccessBootstrap` is stage 6 (`scheduler.ts:40-45`), so a tick that reaches the access leg and then
hangs writes the first and never the second.

**Which produces a genuinely silent corner**, and it is Codex's: a fresh instance ticks (writing an
instance-wide `access_bootstrap` heartbeat), a hang or death prevents stage 7 so no
`context_backfill_all` row ever lands, the first team is created, the scheduler dies. Today: red at
3h. Under the round-2 design: **nothing, ever.** That is the direction this whole family of tickets
exists to prevent, and no amount of prose in a risk table makes it acceptable.

**The fix, and it is the one the codebase already invented.** `access_bootstrap_all` — an
unconditional instance-wide per-tick heartbeat under a DISTINCT source, exactly mirroring
`context_backfill_all`, which exists for this shape and whose comment names `access_bootstrap` as the
untreated twin (`scheduler.ts:386-388`). It restores at the 3h bar the fleet-liveness beat AUDITFIX-22
removed — the one a shipped test comment still claims exists (`pipeline-health-staleness.test.ts:35-37`)
— for every team including the first on a new instance.

⚠️ **This is a deliberate scope increase and not a drift.** It is the safety prerequisite two review
rounds identified: without it this slice trades a false alarm for a silent corner. §3 carries it.

**The boundary no design can cross** (Fable, round 2): an instance whose scheduler is dead **from
boot** has no scheduler rows anywhere, so nothing is aged today either (`pipeline-health.ts:400`
resolves `undefined`). Not a regression, and stated so nobody re-derives it as a hole.

**Why the distinct source rather than reviving the old row.** AUDITFIX-22 removed the instance-wide
`access_bootstrap` row because it MASKED per-team failures under `distinct on (source)`. A separate
source name is the fix that preserves both, and its AC4
(`access-bootstrap-ledger…:197`) asserts no `team_id is null` row for source `access_bootstrap`
specifically — untouched by a new source.

## 6. What this does NOT close, and what it files

- **The wait.** A brand-new team is not aged now, but it still has no clock until its first tick, and
  that tick is one full sequential convergence pass over every team ahead of it (single-flighted,
  overlapping ticks SKIPPED — `lib/ingest/single-flight.ts:39-50`), measured at one cadence (30–86
  min) on a ONE-team fleet and **unbounded if an earlier team hangs** — the honest bound, and the one
  round 2 caught §5a understating as "one cadence".
- **Nothing is filed out of this any more.** Round 0 filed the instance-wide heartbeat as a follow-up
  ticket; round 2 proved the slice is unsafe without it, so it is §3 In-scope instead (§5a).

**Nothing is built. No code exists for this slice.**
