# The access health check runs unattended — AUDITFIX-15

**Status:** spec, **round 1 BLOCKED and folded** (§7). 4 BLOCKER, 6 HIGH, 2 MEDIUM. No code written.
Round 1's headline is that the DETECTOR THIS SLICE WANTED TO SCHEDULE IS ITSELF WRONG — §1a.
**Build with:** opus / high — it decides when a fleet is told its content is unreachable, and the
failure direction is silence.

**Deps: AUDITFIX-13 is the real TIERRET-1 prerequisite, not this.** ⚠️ Round 1 corrected me here and
it matters: `lib/projects/context/reconcile-item.ts:87-98` says in the code itself that the
ingest/reconciler concurrency protocol is the prerequisite, and this alarm does not supply it. This
slice is an **additional** prerequisite — a backstop to ship and *observe on a real fleet* before the
tier read-conjuncts come out, because that retirement removes a net. Observing it green does **not**
authorise starting TIERRET-1.

---

## 0. The defect

`assessAccessHealth` (`lib/admin/access-health.ts:63`) already asks the right question and already
treats the answer as a **blocker**:

```
lib/admin/access-health.ts:163-176
  const unpartitioned = await findUnpartitionedItems(db, teamId);
  if (unpartitioned.count > 0) blockers.push(`… invisible to everyone …`)
```

Its **only shipped caller is `scripts/admin.ts:427`** — a manual CLI command. Verified by grep on
2026-08-22: no scheduler leg, no route, no page, no cron. So on a running fleet **the blocker never
fires**, and under PRET-6 membership-only enforcement an unreachable item is invisible to *everyone
including admins* with nothing reporting it.

This is not a new detector. It is a detector nobody asks.

## 1. Terrain, measured on production (read-only, 2026-08-22, team `aios`, 2,900 items)

| | |
|---|---|
| items unreachable by anyone **right now** | **0** |
| items ingested | **0.028 / minute** (588 in 14 days) |
| `context_backfill` stage | drains **every tick**, `cursor: null`, **12/12** recent runs, **2.6 s** converged |

**The cost question, which is the one that decides the design:**

| how the count is taken | measured |
|---|---|
| `findUnpartitionedItems` — pages `items` 500 at a time, 3 queries per page, **6 pages** for this corpus | first page alone **244 ms**; the full scan is seconds, and grows **O(corpus)** |
| the same answer as **one SQL anti-join** | **96 ms**, and it does not grow with page count |

⚠️ **That is the TICKSTALL-2 lesson again.** The sweep used to walk every item and was replaced by a
candidate predicate for exactly this reason; the coverage scan is the same shape, unconverted. Any
design that puts the *paged* scan into the scheduler tick re-creates the class of defect that caused
**six outages in 14 days**.

## 1a. Round 1's headline: the existing detector's predicate is WRONG

`findUnpartitionedItems` (`lib/projects/context/coverage.ts:36`) treats a project as reachable when **any `project_groups` grant exists**
at `lib/projects/context/coverage.ts:96`. The oracle requires more: an **eligible active principal**
must hold a `group_members` row in a granted group before that project enters their visible set
(`lib/access/oracle.ts:65,74,96`; eligibility at `lib/access/eligibility.ts:28`).

**So a project granted only to an EMPTY group counts as covered while nobody on earth can read it.**

**Measured on prod, 2026-08-22 — the shape exists today:**

| project | group | eligible members |
|---|---|---|
| `external-shared` | `external` | **0** |
| `external-shared` | `everyone` | 5 |
| `general` | `everyone` | 5 |

Latent only because every granted project *also* has a grant to a non-empty group. Remove or empty
`everyone` and the detector reports a clean bill of health over a corpus nobody can see.

**This changes the slice's centre of gravity.** Scheduling a detector that under-reports would have
made the wrong answer arrive reliably. The fix belongs in `lib/projects/context/coverage.ts` — which becomes the **single
owner** of one oracle-exact predicate (§3b), rather than this slice adding a second definition beside
it.

---

## 2. The rule

> **On a cadence, for every team, the instance asks whether any SETTLED item is unreachable by any
> eligible principal — and an answer that is non-zero, unreadable, or NOT TAKEN is recorded as a
> failure, never as a healthy pass.**

Three clauses, each forced by a round-1 blocker:

- **"settled"** replaces the sequencing argument, which was false (§3a).
- **"by any eligible principal"** is §1a — reachability is a chain ending in a person, not a grant row.
- **"or NOT TAKEN"** — a team the sweep DEFERRED, or a pass that could not run, must not read green.
  Round 1 showed both currently do.

## 3. The design

### 3a. A SETTLED cohort, not a sequencing trick — the "steady state is 0" claim was false

Round 0 argued: run the check right after the backfill drains, so the exposure window is ~2.6 s, so
the steady state is 0 and no threshold is needed. **That inference does not survive**, and my own
just-shipped writer inventory is what disproves it. From `test/guards/context-hook-callsites.test.ts`,
four production writers are classified `SWEEP_COVERED` and **do not depend on the sweep's cutoff at
all**: the codebases push route, `note.create`, manual connector syncs, and the seed script. Any of
them can commit an item *after* the cutoff and *before* the check, and the sweep deliberately
excludes it — a healthy, expected operation that would be reported as a fault.

It is worse on a fleet: `backfillAllTeams` defers teams when the shared budget expires
(`lib/projects/context/backfill.ts:240-249`), so team A can drain early and then wait minutes while
other teams consume the budget. And "drained" is a **read observation, not a transactional
invariant** — a writer whose `created_at` precedes the cutoff can commit after the final candidate
query.

**So: assess only a SETTLED cohort.** An item is settled once `created_at < now() - SETTLE_MS`,
where `SETTLE_MS` covers a full sweep interval plus one stage (default: `2 × INGEST_POLL_MINUTES`).
An unsettled item is *expected* to lack context and is excluded from the count and reported
separately as `pending`.

⚠️ **This is a tolerance, and it is derived rather than fitted** — it comes from the configured poll
interval, not from a number chosen to make prod look green. `docs/design/staleness-threshold-fit.md`
is this repo's record of what fitting a constant to one window costs.

### 3b. ONE owner: `lib/projects/context/coverage.ts` gains a canonical SQL predicate

Round 1 was right that AC5-style "the two definitions must agree on a fixture" preserves two owners
and proves agreement only on that fixture — and it would have blessed §1a's defect twice.

`lib/projects/context/coverage.ts` becomes the single read-only owner (it already lives apart from
the writers precisely so it can name the substrate tables without tripping the single-writer guard's
table-name net). It exposes two readers over **one** SQL predicate:

```ts
unreachableItemCount(db, teamId, opts): Promise<{ settled: number; pending: number; examples: string[] } | null>
findUnpartitionedItems(db, teamId)  // kept for the CLI, now built on the same predicate
```

The predicate is the **full chain**, matching the oracle rather than a proxy for it:

```
items → ACTIVE item unit → CURRENT include membership → project → project_groups grant
      → group_members → an ELIGIBLE ACTIVE principal
```

`runSql`, because `NOT EXISTS` is not expressible through the query builder — the justification
`lib/projects/context/backfill-candidates.ts` already carries. `null` on failure, never 0 (`countUnrepairable`'s rule).

### 3c. Per-team outcome classification — an unknown is not a pass

Round 1's BLOCKER 3: truncation is deliberately `ok:true` + metadata
(`lib/ingest/scheduler.ts:431-448`) and a **deferred team gets no row at all**
(`lib/projects/context/backfill.ts:238-249`), while pipeline-health reads `ok`/`errors`, not metadata
(`lib/ingest/pipeline-health.ts:296-332`). So my round-0 claim that skipping those states avoided
"double-counting a failure already reported" was false — **nothing reports them**.

`runContextBackfill` must therefore return its `AllTeamsResult` (it returns `Promise<void>` today,
`lib/ingest/scheduler.ts:352`) so the health leg can classify **every team the same stage invocation touched**:

| backfill outcome for the team | health leg records |
|---|---|
| drained | the real assessment — `ok:false` if any settled item is unreachable |
| truncated / failed | `ok:false`, "assessment not taken — the sweep did not drain" |
| **deferred** (no row today) | `ok:false`, "assessment not taken — team deferred by the stage budget" |

### 3d. The leg must be REGISTERED, and the banner must not say something false

Round 1 resolved both of §6's open questions with file:line, and one of my claims was wrong:

- **Unknown sources ARE consumed** (`pipeline-health.ts:393`) and **BANNERFLAP-1's confirm-on-two
  debounce applies generically** (`402-421`, `454-464`) — so one blip stays quiet. Good.
- **But an unregistered source inherits a 3-hour staleness default** (`pipeline-health.ts:20,166-167`),
  and two shipped guards require every real source to be declared
  (`test/guards/ingest-leg-ledger.test.ts:105-120`, `test/pipeline-health-staleness.test.ts:124-166`).
  So `access_health` goes into `INGEST_LEG_SOURCES` with an **explicit staleness answer of `null`**
  until its cadence is independently measured — the upstream legs already detect scheduler silence.
- **The banner's sentence is false for this leg.** It renders *"ingestion leg is broken — the brain
  isn't getting fresh data"* (`components/admin/pipeline-health-banner.tsx:83-86`). A deleted grant
  or an emptied group leaves data perfectly fresh and simply unreadable. The repo already excluded
  `llm` for exactly this mismatch (`pipeline-health.ts:182-202`).
  **Decision: broaden the banner copy for a non-ingestion leg** rather than ship a sentence that
  lies or invent a second banner with no other consumer. One `access_health` leg renders
  *"content is unreachable — N item(s) can be read by nobody"*, linking to Admin → Access.

### 3e. What is NOT claimed

- **The recorded failure can still vanish.** `recordIngestRun` swallows its insert errors
  (`lib/ingest/runs.ts:55-81`) and `getPipelineHealth` returns healthy on its own read failure
  (`pipeline-health.ts:466-468`). If Postgres is unhealthy, the count fails, the `ok:false` row fails
  to write against the same database, and the last green row stays newest. So the leg **also** writes
  a `console.error`, and this limitation is stated rather than papered over. Making the ledger itself
  fail-loud is a different slice.
- **This does not unlock TIERRET-1** (§ header) — AUDITFIX-13 does.
- **Only the unreachable-items arm runs on the cadence.** `assessAccessHealth`'s blind-principal arms
  resolve the oracle once per principal (`lib/admin/access-health.ts:99-133`), i.e. O(members × teams)
  per tick. Out until measured; the CLI keeps them.

## 4. Scope

**In:** the canonical predicate in `lib/projects/context/coverage.ts` (one owner, oracle-exact) · `findUnpartitionedItems`
rebuilt on it · a `runAccessHealth` leg **adjacent to** `runContextBackfill`, consuming its returned
outcomes · `runContextBackfill` returning `AllTeamsResult` · `access_health` in `INGEST_LEG_SOURCES`
with `null` staleness · banner copy for a non-ingestion leg · `docs/ARCHITECTURE.md`.

**Out:** the blind-principal arms (§3e) · a fail-loud run ledger (§3e) · any new admin page ·
**`drift:sources`** — round 1 showed that block is derived from the Python connector `_REGISTRY`
(`scripts/check-docs-drift.mjs:60-67,104-109`), so adding `access_health` there would **fail**
`check:docs` as an extra source. My round-0 AC7 asserted the opposite and was simply wrong.

## 5. Acceptance

- **AC1 — an item reachable only through an EMPTY group counts as unreachable (dm):** grant a project
  solely to a group with no eligible members; the item is counted. *This is §1a — the criterion the
  shipped detector fails today.*
- **AC2 — the chain is exact (dm):** a matrix over active/inactive members, connector members,
  off-roster members, an empty group, and a healthy control. Each row's expected count asserted.
- **AC3 — a SETTLED unreachable item makes the leg FAIL (dm):** recorded as `ok:false` with the count
  in `errors`, asserted on the persisted row.
- **AC4 — an UNSETTLED item does NOT fail the leg (dm):** an item newer than `SETTLE_MS` is reported
  as `pending`, not as a fault. The false-alarm direction §3a exists to prevent.
- **AC5 — a DEFERRED team is `ok:false`, not silent (dm):** with the stage budget forced so a team is
  deferred, that team gets a row saying the assessment was not taken. Today it gets no row at all.
- **AC6 — a truncated sweep does not read as healthy (dm).**
- **AC7 — an unreadable count is `ok:false`, never `ok:true` (dm).**
- **AC8 — one owner (unit):** `findUnpartitionedItems` and `unreachableItemCount` return the same
  count over the AC2 matrix **because they execute the same SQL** — asserted by pinning that the
  predicate string has exactly one definition site, not by comparing two implementations.
- **AC9 — the leg is ADJACENT and FLEET-TOTAL (unit guard):** the scheduler calls `runAccessHealth`
  immediately after `runContextBackfill`, passing its returned outcomes, and records one classified
  row per team **in that result** — deferred teams included. *Round 1's compliant-but-wrong
  implementation — call it at the bottom of the tick and iterate only `outcomes` — must fail this.*
- **AC10 — the leg is registered and its staleness is explicit (unit):** `access_health` is in
  `INGEST_LEG_SOURCES`, the ledger guard passes, and the staleness test sees an explicit `null`
  rather than inheriting the 3-hour default.
- **AC11 — the banner does not claim stale data (unit):** a loud `access_health` leg renders the
  unreachable-content sentence, not "the brain isn't getting fresh data".
- **AC12 — constant ROUND TRIPS (dm):** the leg issues the same number of queries for a 10-item and a
  1,000-item corpus. *Round 1: this bounds round trips, not database work — the SQL predicate and its
  supporting indexes are pinned separately, with `EXPLAIN` evidence at release rather than a
  wall-clock threshold, which would be flaky.*

## 6. Open questions the next round must settle

1. **Is `2 × INGEST_POLL_MINUTES` the right settle window**, or does it need to account for a team's
   position in the deferral rotation (worst case is `team_count` passes, not one)?
2. **Broadening the banner copy touches a shipped surface** with its own tests. Is that in scope here,
   or does the leg stay excluded from the banner until the copy change lands separately?
3. **Is `unreachable` even the right severity for a `pending` backlog** on a fleet where a team is
   chronically deferred — that is a capacity problem wearing an access-alarm costume.

---

## 7. Round 1 — BLOCKED, and the detector I wanted to schedule was itself wrong

**4 BLOCKER, 6 HIGH, 2 MEDIUM.** Every finding re-derived against the code before folding; one
verified against production.

| # | finding | outcome |
|---|---|---|
| **B1** | the predicate does not mean "reachable by anyone" — `coverage.ts:96` accepts any grant, while the oracle requires an **eligible principal's own `group_members` row** (`oracle.ts:65,74,96`, `eligibility.ts:28`) | **CONFIRMED, and verified on prod**: `external-shared` is granted to `external`, which has **0 eligible members**. Latent only because `everyone` also holds it. This is a defect in **shipped** code, and it re-centres the slice (§1a, §3b) |
| **B2** | "sequencing makes the steady state 0" is false — several writers do not depend on the sweep's cutoff, teams get deferred, and "drained" is a read observation not a transactional invariant | **CONFIRMED**, and my own just-shipped writer inventory is what disproves it: four writers are classified `SWEEP_COVERED`. The Poisson argument is withdrawn for a **settled cohort** derived from the poll interval (§3a) |
| **B3** | skipping truncation/deferral is not "double-counting" — truncation is `ok:true` + metadata and a **deferred team gets no row at all**, and pipeline-health reads neither | **CONFIRMED.** Nothing reports them. Per-team classification, and an unknown is never a pass (§3c) |
| **B4** | this does not unlock TIERRET-1; `reconcile-item.ts:87-98` names **AUDITFIX-13** as the prerequisite, and "Deps: none" contradicted the codebase | **CONFIRMED**, corrected in the header |
| **H5** | unknown sources ARE consumed and BANNERFLAP-1 debounce DOES apply — but an unregistered leg inherits a 3-hour staleness default, and two shipped guards require declaration | **CONFIRMED**, and it resolved §6's open question with file:line. Registered with explicit `null` staleness (§3d) |
| **H6** | `ok:false` is mechanically right and semantically false — the banner says *"the brain isn't getting fresh data"*, and `llm` was already excluded for this exact mismatch | **CONFIRMED.** Banner copy broadens for a non-ingestion leg rather than shipping a sentence that lies (§3d, AC11) |
| **H7** | AC6 did not pin adjacency or fleet-totality; a compliant implementation could run at the bottom of the tick and skip deferred teams | **CONFIRMED.** AC9 now names that exact implementation as the thing it must fail, and `runContextBackfill` must return its outcomes |
| **H8** | AC5 preserved two owners and would have blessed B1's defect twice | **CONFIRMED.** One owner; AC8 pins a **single definition site** rather than comparing two implementations |
| **H9** | AC7 was factually wrong — `drift:sources` derives from the Python connector `_REGISTRY`, so adding `access_health` would **fail** `check:docs` | **CONFIRMED. Dropped**, with the reason recorded in §4 |
| **H10** | "unreadable is a failed run" is not unconditional — `recordIngestRun` swallows insert errors and `getPipelineHealth` returns healthy on its own read failure | **CONFIRMED.** Stated as a limitation with a console path, not papered over (§3e) |
| **M11** | AC8 proved constant round trips, not bounded database work | **CONFIRMED**, renamed and split from the index/`EXPLAIN` evidence (AC12) |
| **M12** | build the narrower detector; do not schedule the full assessment | **CONFIRMED**, already the scope (§3e) |

**Nothing is built. No code exists for this slice.**
