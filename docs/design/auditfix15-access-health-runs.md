# The access health check runs unattended — AUDITFIX-15

**Status:** spec, round 0. No code written.
**Build with:** opus / high — it decides when a fleet is told its content is unreachable, and the
failure direction is silence.

**Deps:** none to build. It is the **named prerequisite for TIERRET-1**: the plan is to ship this
backstop and *look at its output on a real fleet* before the tier read-conjuncts come out, because
after that retirement one wrong group-add exposes the whole corpus with nothing to catch it.

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

## 2. The rule

> **On every scheduler tick, immediately after the context-backfill stage, the instance asks whether
> any item is unreachable — and a non-zero answer is recorded as a FAILED run, not as metadata.**

Two clauses, both load-bearing:

- **"immediately after the backfill stage"** is what makes the signal honest (§3a).
- **"a FAILED run, not metadata"** is what makes it visible. `lib/ingest/pipeline-health.ts` reads
  `ok`/`errors`, **not** `meta` — a count in `meta` turns no banner red. AUDITFIX-2's round 1 caught
  me asserting exactly that handoff without checking it.

## 3. The design

### 3a. Sequencing removes the threshold problem entirely

The obvious worry — *"the steady-state count is non-zero by design, so what threshold is honest?"* —
is an artefact of asking at the wrong moment. Ask **right after the sweep drains**, and the only
items lacking context are those created in the gap.

Measured: **0.028 items/minute** against a **~2.6 s** window ⇒ an expected **0.0014 items** per tick.
So the steady state is **0**, not "some small number", and **any non-zero value is a real signal**.
No threshold, no fudge factor, no fitted constant — which this repo has been burned by before
(`docs/design/staleness-threshold-fit.md`).

⚠️ **Stated, not buried:** if the backfill stage `truncated` (budget) or returned `ok:false`, the
count is expected to be non-zero and reporting it as a fault would be **double-counting a failure
already reported**. In that case the health leg records `skipped` with the reason rather than a
blocker.

### 3b. The count is ONE query, not a paged scan

A new read-only module (mirroring `lib/projects/context/coverage.ts`'s single-writer-guard reasoning:
a file that only READS the substrate tables can never be the file the guard flags) exposing:

```ts
unreachableItemCount(db, teamId): Promise<{ count: number; examples: string[] } | null>
```

- One `NOT EXISTS` anti-join over `items`, mirroring `coveredItemIds`'s exact conjunction: an
  **active** item unit, carrying a **current include** membership, into a project **some group is
  granted**. `runSql`, because `NOT EXISTS` is not expressible through the query builder — the same
  justification `backfill-candidates.ts` already carries.
- A second bounded query for up to 5 example paths, so an operator sees *what* would vanish.
- **`null` on failure, never 0** — `countUnrepairable`'s rule. "Could not read" must not be spelled
  the same as "there are none" for a metric whose only job is making an invisible hole visible.

**`findUnpartitionedItems` is NOT deleted or changed.** The CLI keeps it: a human running
`access-health` on one team can afford the per-item answer, and it reports `truncated` and `scanned`,
which the aggregate cannot. ⚠️ **The two definitions must not drift** — AC5 asserts they agree on the
same fixture, the same way `PROTECTED_EXCLUDE_SQL` is pinned across its three owners.

### 3c. What is recorded

One `ingest_runs` row per team per tick, `source: "access_health"`, through the single writer
`recordIngestRun`:

| state | row |
|---|---|
| count is 0 | `ok: true`, `meta: { unreachable: 0 }` |
| count > 0 | **`ok: false`**, `errors: ["N item(s) are unreachable by anyone"]`, examples in `meta` |
| count could not be taken (`null`) | **`ok: false`**, `errors: ["unreachable-item count could not be read"]` — an unreadable detector is not a passing grade |
| backfill truncated / failed this tick | `ok: true`, `meta: { skipped: "backfill did not drain" }` |

That makes it a first-class leg of the pipeline-health banner **by construction**, with no new
surface to build and no handoff to assert.

⚠️ **`source: "access_health"` is a NEW leg on that banner.** `pipeline-health` classifies unknown
sources and applies staleness rules; the spec must confirm a new source does not go loud merely for
being unfamiliar, and that `BANNERFLAP-1`'s confirm-on-two-failures debounce applies. **Not yet
verified — §6.**

### 3d. Scope of the check, stated narrowly

This leg asks **only** the unreachable-items question. `assessAccessHealth`'s other arms (blind
humans, unplaced agents, connector warnings) each call `visibleProjects` **per principal** — 9 oracle
round-trips today, O(members) on a fleet — and belong in the same leg only after that cost is
measured. Deliberately out; the CLI keeps them.

## 4. Scope

**In:** the new read-only count module · a `runAccessHealth` scheduler leg sequenced after
`runContextBackfill` · `docs/ARCHITECTURE.md` (sources-of-truth row + the `drift:sources` block, since
this adds an ingestion source).

**Out:** blind-principal checks in the tick (§3d) · any new admin UI (the existing banner is the
surface) · changing `findUnpartitionedItems` or the CLI.

## 5. Acceptance

- **AC1 — a genuinely unreachable item makes the leg FAIL (dm):** delete an item's membership; the
  leg records `ok:false` with the count in `errors`. Asserted on the recorded row, not a return value.
- **AC2 — a healthy team records `ok:true` with `unreachable: 0` (dm).**
- **AC3 — an unreadable count is `ok:false`, never `ok:true` (dm):** with the query faulted, the row
  is a failure and says so. The direction that makes the metric worth having.
- **AC4 — a truncated backfill records `skipped`, not a blocker (dm):** with the stage budget forced
  to truncate, the leg does not double-report a failure the backfill already reported.
- **AC5 — the one-query count AGREES with `findUnpartitionedItems` (dm):** over a fixture spanning
  every arm — no unit, unit with no membership, membership into an ungranted project, retracted unit,
  healthy — both return the same count. This is what stops the two definitions drifting.
- **AC6 — the leg is wired and pinned (unit guard):** the scheduler calls it, and it is sequenced
  AFTER `runContextBackfill`. Deleting either must redden.
- **AC7 — a new ingestion source is declared (docs drift):** `npm run check:docs` passes with
  `access_health` in the `drift:sources` block.
- **AC8 — cost is bounded and asserted (dm):** the leg issues a **constant** number of queries
  regardless of corpus size — proven by seeding two corpora of different sizes and asserting the
  query count is equal, not merely "fast".

## 6. Open questions the review must settle

1. **Does a new `source` go loud on the pipeline-health banner for the wrong reason?** Unverified.
   `lib/ingest/pipeline-health.ts` has per-leg staleness rules and a suppression list; a new leg may
   need registering, and BANNERFLAP-1's debounce must apply or a single blip latches the banner red.
2. **Is `ok:false` the right channel at all**, or does it pollute "ingestion legs are broken" with a
   fact that is not an ingestion failure? The alternative is a distinct surface — which is a bigger
   slice and has no consumer today.
3. **Multi-team fleets:** one row per team per tick is O(teams) queries. At what team count does this
   need the same rotation/budget treatment as the backfill stage?
4. **Is 0.0014 expected items per tick actually the right model?** It assumes ingest is Poisson and
   independent of the tick, and prod is a single team ingesting in bursts right before the stage. A
   burst arriving *during* the 2.6 s window is rarer still, but the model should be attacked.
