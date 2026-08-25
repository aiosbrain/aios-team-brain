# The staleness beat must read the partition its poller actually writes — AUDITFIX-24

**Status:** spec, round 1 folded (Codex **BLOCKED**, Fable **CLEAR-WITH-CONDITIONS** — they overlapped
on almost nothing and disagreed on the central question). No code written. Filed 2026-08-23 out of
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

**This is the number the whole design argument turns on.** Since the AUDITFIX-22 deploy the
instance-wide `access_bootstrap` clock has not moved at all — so for a team with no scheduler row of
its own, `stale` is `true` **whether the scheduler is alive or dead**. It is not a three-hour alarm
for that team; it is a lamp wired to on. See §5a.

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
- **NO scheduler beat at all:** `arcs` — deliberately `trigger:"api"`, and the comment says why
  (`lib/graph/arcs.ts:1254-1256`: *"`scheduler` rows are read as poller-heartbeat evidence in
  pipeline-health; this one is not that"*) · `llm` (`trigger:"api"`, and not a pipeline leg at all) ·
  `pm_sync` (reactive/manual) · `scan` (`trigger` comes from a **client header**,
  `app/api/v1/codebases/route.ts:10,48-49` — so a caller can *claim* `scheduler`; its threshold is
  `null`, but a future finite one would inherit a spoofable beat).

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

- a `team` source has ≥1 `trigger:"scheduler"` call site passing a `teamId`;
- a `global` source has ≥1 `trigger:"scheduler"` call site passing none;
- a `none` source has **no** `trigger:"scheduler"` call site — and, separately, **may not carry a
  finite `STALE_MS_BY_SOURCE` threshold**, because a finite bar on a leg that can never resolve a
  clock is silence by construction;
- `access_bootstrap` is the ONE documented exception (§0c): declared `team`, and it legitimately has
  instance-wide sites too.

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
the writers) · new unit + dm criteria · **converting AUDITFIX-22's AC13** · **correcting a false
comment in `test/pipeline-health-staleness.test.ts:36-37`**, which still says *"access_bootstrap
writes an unconditional instance-wide heartbeat"* — untrue since AUDITFIX-22 and measured at 0
instance-wide rows/day in §0a, and it is the exact sentence this slice's model contradicts.

**Out:**
- **Thresholds.** `STALE_MS_BY_SOURCE` is untouched. This changes WHICH clock is read, never the bar.
- **The verdict/streak read.** `STREAK_SQL` keeps choosing the leg from the newest partition. ⚠️ *My
  round-0 claim that the beat was "the last read in this file that mixes partitions" was FALSE —
  the `newest` CTE mixes them too (`:321-325`), deliberately, and AUDITFIX-22's AC5 depends on it.*
- **Restoring an unconditional instance-wide `access_bootstrap` heartbeat** — §5a argues the refusal
  and §6 files it.
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
  `false`. *`context_backfill_all` because it is global-only, has a finite (6h) threshold, and is not
  connector-suppressed.*
- **AC5 — a team-beat leg is judged per TEAM (dm):** two teams; A has a recent scheduler row, B has
  none. B not stale, A not stale; then age A's row — **A is stale and B is explicitly asserted NOT
  stale.** *That last assertion is load-bearing: without it mutation 9 survives, because under it B
  borrows A's FRESH row and the first two clauses still pass (Fable MEDIUM).*
- **AC6 — the fail-open path is unchanged (unit):** `resolveBeatClock` with `beats === null` returns
  the leg's own `finished_at`, for every scope.
- **AC7 — every ledger source declares a beat scope AND the declaration matches its writers (unit
  guard):** key-set parity, plus the §2a cross-check. *Parity alone proves nothing about any scope
  VALUE — a wrong value for `auth_cleanup` would pass it and lose a 26h alarm (Codex HIGH).*
- **AC8 — `none` may not carry a finite threshold (unit guard):** a `none` source with a number in
  `STALE_MS_BY_SOURCE` fails the build. *A finite bar on a leg that can never resolve a clock is
  silence by construction.*
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

⚠️ **Mutations 4, 8, 12 and 13 all exist because writing this table found the criteria missing.**
Mutation 4 was the round-0 catch (AC1 cannot see it). Mutation 8 is the one that matters most: it is a
real future edit, and before §2a's cross-check NOTHING in this slice could redden it.

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

### 5a. The one real regression, its measured size, and why it is refused

⚠️ **Codex BLOCKED on this and I am not taking the fix. Here is the argument, so round 2 can attack
it rather than re-derive it.**

The scenario: an instance ticks normally, a team is created (writing a `trigger='api'` creation row
only), and the scheduler process **dies** before that team's first scheduler tick. Today the frozen
instance-wide `access_bootstrap` row ages and the banner reds at 3h. Under this design that leg
resolves no clock and says nothing.

**What today's 3h alarm is actually worth for that team: nothing.** §0a measures zero instance-wide
`access_bootstrap` rows per day since 2026-08-23. The fossil is aged whether the scheduler is alive or
dead, so for a team with no rows of its own that lamp is **wired on**, not reporting. Replacing a
constant-true indicator with a silent one loses no information — it loses a coincidence.

**What still covers the scenario:** `context_backfill_all` is an unconditional instance-wide per-tick
heartbeat (`scheduler.ts:393-395`, and on a throw `:415-419`; 648 rows ≈ 48/day in §0a, i.e. every
tick) with a **6h** threshold (`pipeline-health.ts:88`), and instance-wide rows ARE in a new team's
scope. `auth_cleanup` backstops at 26h on every instance regardless of connectors. So detection
degrades **3h → 6h** in this corner, and never to silence. *(Codex said "at least 3h→6h, possibly
silent"; the silent half does not hold, because `context_backfill_all` is unconditional. Fable said
26h; that is the backstop, not the first responder.)*

**And the exposure is one cadence.** The affected population is "teams created since the last tick" —
30–86 min measured on this fleet. Any team that has ever ticked has its own 3h clock, permanently.

**The alternative I am refusing:** add `access_bootstrap_all`, an unconditional instance-wide
heartbeat under a distinct source, mirroring `context_backfill_all` — which was invented for exactly
this shape and whose comment names `access_bootstrap` as the untreated twin (`scheduler.ts:386-388`).
It would restore a genuine 3h fleet beat for every team. It is refused **here** because it is a new
permanent leg on every team's health panel, needing its own threshold decision and criteria, to buy
3h of earlier detection in a one-cadence window — and this lane has twice been blocked for widening a
slice past the defect it named. It is §6.

## 6. What this does NOT close, and what it files

- **The wait.** A brand-new team is not aged now, but it still has no clock until its first tick, and
  that tick is one full sequential convergence pass over every team ahead of it (single-flighted,
  overlapping ticks SKIPPED — `lib/ingest/single-flight.ts:39-50`), measured at one cadence (30–86
  min) on a ONE-team fleet and unbounded if an earlier team hangs.
- **FILE AS ITS OWN TICKET:** restore an unconditional instance-wide scheduler heartbeat for the
  access leg (`access_bootstrap_all`), per §5a — AUDITFIX-22 removed one that a shipped test comment
  still claims exists, and the measured 3h→6h gap is the cost.

**Nothing is built. No code exists for this slice.**
