# The codebases push route partitions what it stores — AUDITFIX-2, re-scoped

**Status:** spec, **rewritten from scratch**. The previous document
(`auditfix2-connector-reconcile-at-ingest.md`, branch `fix/auditfix-2-connector-reconcile`, two
rounds, both BLOCKED, never built) rested on **two claims that are false**, and this one refutes them
with the code and a fresh production measurement (§0, §1). Its design is **declined here, with
evidence** (§6). No code has been written for either document.

**Build with:** opus / high — it changes what a write path owes the access substrate, where the
failure mode is silent unreachability rather than a crash.

**Deps: none.** Slice 2 of the Phase A audit remediation (AIO-847/848/850/865/872). Does not touch
`lib/access/*`; the overlap with AUDITFIX-4 (merged, PR #640) is the reconcile core it calls, not
its internals.

---

## 0. The two false premises, refuted before anything is designed

The audit's H1 and both prior spec rounds rest on these. Neither survives re-derivation.

### 0a. "The sweep's cutoff excludes items created during the tick that ingested them"

Written in the prior spec §5 as the one thing round 1 *confirmed*, and it is the entire basis of that
document's round-2 proposal — *"make the sweep's cutoff not exclude items created during the tick…
one predicate change against a budgeted, restartable, already-correct stage."*

**It is not what the code does.**

- `lib/ingest/scheduler.ts:353` — `const startedAt = Date.now();` is the first statement of
  **`runContextBackfill`**, i.e. the moment that *stage* begins.
- `lib/ingest/scheduler.ts:359` — `const cutoff = new Date(startedAt).toISOString();` The adjacent
  comment says *"Cutoff = tick start"*; the value is **stage** start. The comment is the source of
  the mistaken premise, and it is wrong.
- `lib/ingest/scheduler.ts:29-46` — the tick is a sequential `await` chain: slack → plane → linear →
  inbound → **github** → auth cleanup → access bootstrap → **`runContextBackfill`**. Every connector
  leg has already run and returned when the cutoff is taken.

So an item ingested by a connector leg has `created_at < cutoff` **by construction** and is
selected by `selectCandidateItemIds` in the very same tick. There is no cutoff change to make; the
proposed "cheapest correct slice" has nothing to act on.

### 0b. "The median lag is 30–72 minutes"

That measurement was taken while the backfill stage still cost ~59 minutes per pass, so an item
ingested in tick *N* was routinely partitioned in tick *N+1* or later. **TICKSTALL-2's candidate
predicate** (`lib/projects/context/backfill-candidates.ts`) replaced the O(corpus) reconcile loop
with an anti-join, and the number collapsed.

**Measured on production, read-only, 2026-08-22 — the stage as it runs today:**

| the 12 most recent `context_backfill` runs | value |
|---|---|
| `drained` | **true — 12/12** |
| `truncated` | **false — 12/12** |
| `cursor` at end of pass | **`null` — 12/12** (nothing stranded, no rotation debt) |
| `elapsedMs`, converged (`scanned: 0`) | **~2,640 ms** |
| `elapsedMs`, with work (`scanned: 2`) | **6,157 ms** |

The stage is neither budget-truncated nor cursor-stranded. It fully drains every 30-minute tick in
under three seconds.

**Ingest → partition lag, same 14-day window as the original ticket, bucketed by day
(`github`/`linear`/`commits`, n = 528):**

| day | n | median (min) | p90 (min) |
|---|---|---|---|
| 2026-08-10 | 19 | **1,579.4** | 1,639.3 |
| 2026-08-11 | 22 | 224.8 | 265.6 |
| 2026-08-12 | 12 | 60.3 | 124.6 |
| 2026-08-16 | 172 | 84.6 | 212.0 |
| 2026-08-18 | 69 | 63.0 | 208.6 |
| 2026-08-19 | 39 | 19.6 | 34.4 |
| 2026-08-20 | 67 | 19.7 | 22.6 |
| **2026-08-21** | 53 | **8.6** | **33.9** |

The 14-day aggregate the ticket quotes (72 / 31 / 30 min) is a **mixture of two regimes**, dominated
by the one that no longer exists. Reporting it as current state would have justified a build against
a defect another slice had already fixed.

**Per-item, last 3 days, in-tick connector legs:** a `github` item created at `23:39:28` has its unit
at `23:41:20` — **1.9 min**, same tick, matching the `context_backfill` run recorded at `23:41:17`.
Five consecutive `github` items measure 0.8–1.9 min. That is §0a's conclusion observed rather than
argued.

**What that leaves.** The connector legs are not the problem. One path is.

---

## 1. The defect that survives: two sibling push routes, one of which forgets

| route | ingests | reconciles |
|---|---|---|
| `POST /api/v1/items` (`app/api/v1/items/route.ts:162-181`) | workspace CLI content | **yes** — `reconcileItemContext` inside `after()`, best-effort, never blocks the response |
| `POST /api/v1/codebases` (`app/api/v1/codebases/route.ts:54`) | git commits, via `ingestCodebaseScan` → `projectCommitsToItems` (`lib/codebases/commits-to-items.ts:117`) | **no** |

Both are authenticated push routes, outside the scheduler's single-flight chain. One partitions what
it stores; the other waits for a sweep it does not trigger. The measured consequence:

| path | items, 14 d | share | median lag today |
|---|---|---|---|
| `commits/…` (codebases route) | **378** | **64 %** | **8.0–8.8 min**, up to the full 30-min tick interval |
| `1-inbox/`, `2-work/` (items route) | 41 | 7 % | **0.0 min** (41/41 partitioned inside 60 s) |

**And it is live at the moment of writing.** Exactly one item in production has no
`project_context_units` row:

```
d05b4000-222e-4d29-a197-43c17c5cdad1  commits/aios-team-brain/a93a0a3f70.md  created 03:15:32Z
last context_backfill: 03:05:31Z   →   next: ~03:35Z
```

`a93a0a3f` is the merge commit that closed AUDITFIX-4. Under **PRET-6 membership-only enforcement**,
`visibleItemIds` is built solely from current include-memberships, so for that ~30-minute window the
item is stored and reachable by **nobody — admins included**. Fail-closed, self-healing, and real.

**Why this route is not the connector-leg design in disguise.** The objection that killed both prior
rounds was cost inside the single-flight tick (`383 × 1.3 s ≈ 8.3 min` → TICKSTALL-1 re-created).
It does not reach here:

- A route is **not** in the tick. Nothing it does can starve a scheduler stage.
- The work runs in **`after()`** — after the response is sent, exactly as the items route already
  does, so push latency is untouched by construction.
- **Measured batch size:** 205 codebases pushes in 14 days, **avg 1.8 items, p90 2, max 100**. The
  ~1.3 s/item figure is itself stale (§0b measures a 2-item pass at 6.2 s, ~1.8 s/item of which
  ~2.6 s is fixed overhead) — but at *either* number the p90 push reconciles two items.
- The scheduler sweep remains the backstop for the max-100 tail and for any `after()` that never
  runs, unchanged.

---

## 2. The rule

> **A production path that stores an item either partitions it in the same run, or is on an
> enumerated allow-list that records why the sweep is sufficient for it.**

Stated this way rather than as "every path reconciles", because the enumeration is the durable half:
the sweep genuinely *is* sufficient for the in-tick legs (§0b), and a rule that forbade what is
already correct would be a rule nobody could keep.

Three qualifiers, each carried forward from a prior round that was right:

- **Never inline.** The reconcile runs after the response. `test/guards/context-hook-callsites.test.ts:22`
  pins that for the items route (*"must run in after(), not inline (never blocks the push)"*); making
  it inline anywhere reverses a shipped, tested contract.
- **Never fails the push.** A reconcile failure costs latency, not the write. The sweep is the backstop.
- **Not inside `ingestItem`.** That would make it inline for the items route (reversing the above) and
  would put every unit-test caller of `ingestItem` onto the context tables, which
  `lib/ingest/fake-supabase.ts` cannot model.

---

## 3. The design

### 3a. `projectCommitsToItems` returns ids, not a count

Today it discards every `ingestItem` result and returns `processed` (`commits-to-items.ts:102-120`),
so the route has nothing to reconcile even if it wanted to. It returns the ids that need
partitioning, using the **same trigger the items route uses**:

```ts
if (result.status !== "unchanged" || result.accessChanged) ids.push(result.id);
```

`accessChanged` is load-bearing and is pinned for the items route by the existing guard's
*"must fire on a heal-path tier flip (accessChanged), not only status change"* assertion — a tier
flip arrives as `status: 'unchanged'` and is the security-relevant MOVE. Dropping it here would
reproduce the slice-5 Fable HIGH on the commits path.

`ingestCodebaseScan` propagates them (`{ contributions, issues, commitItemIds }`); its existing
numeric return values are unchanged, so `app/api/v1/codebases/route.ts`'s response body and its
`recordIngestRun` meta keep their current shape.

### 3b. The route reconciles them in `after()`

Mirroring `app/api/v1/items/route.ts:162-181`, including its `try`/`catch` around the `after()`
**registration** — `after()` throws outside a request scope (the in-process handler tests), and a
throw there must not fail a push that already succeeded.

Sequential, not `Promise.all`: `reconcileItemContext` takes writes on shared substrate rows, the p90
batch is 2 items, and a fan-out buys nothing while adding a contention mode. A per-batch cap
(`RECONCILE_AT_PUSH_MAX`) bounds the max-100 tail; **items past the cap are counted and left to the
sweep**, and the count is recorded rather than dropped — a silent cap is the failure this slice's
own §4c exists to prevent.

### 3c. The guard enumerates the call sites

`test/guards/context-hook-callsites.test.ts` claims to pin "the §11 context-partition CALL SITES" and
pins **three named files**; it never enumerates `ingestItem`'s callers, so a new ingest path joins the
waits-for-the-sweep set with nothing failing the build. That is precisely how the codebases route got
here.

The guard becomes an **enumeration with a closed allow-list**: it discovers every production
`ingestItem(` call site by source scan (excluding `test/`, `*.test.ts` and `lib/ingest/fake-supabase.ts`),
and asserts each file is in exactly one of two sets — **reconciles** (the file also references
`reconcileItemContext`) or **sweep-covered**, each entry carrying a written reason in the guard
itself. A new call site in neither set **fails the build**.

⚠️ **Stated as a limitation, not sold as more than it is:** this is a source-level pin, the same class
as the existing guard. It proves a file *mentions* the reconcile, not that the reconcile is reached
for every item. The behavioural half is AC1/AC2 in the data-mechanics tier; the guard exists to stop
the *set of paths* drifting, which no dm test can see.

### 3d. The residual becomes a number

`backfillOneTeamTurn` reports `scanned`, which is *candidates found during this pass* — after a
drained pass it is 0 whether the corpus is partitioned or the predicate stopped matching. Nothing
anywhere counts **items with no active item unit**, the state that means "stored and reachable by
nobody".

One count per team per pass, recorded into the existing `ingest_runs.meta` the stage already writes,
as `awaitingPartition`. `null` when the count could not be taken — never 0, following
`countUnrepairable`'s rule that "could not read" must not be spelled the same as "there are none".

⚠️ **Honestly scoped: this is diagnosis, not an alarm.** `lib/ingest/pipeline-health.ts` reads
`ok`/`errors`, not `meta`, so a non-zero `awaitingPartition` does **not** turn any banner red, and
`lib/admin/access-health.ts` does not consume it either. I am not claiming a handoff I have not
built — round 2 of the prior spec caught exactly that assertion and it was right. Making it loud
needs a threshold nobody can yet derive (the steady-state value is non-zero by design: items pushed
*during* a pass). The number has to exist and be observed before a threshold can be honest. Wiring
it to a health surface is named as the next slice, not implied here.

---

## 4. Scope

**In:**
1. `lib/codebases/commits-to-items.ts` — return ingested item ids.
2. `lib/codebases/ingest.ts` — propagate them.
3. `app/api/v1/codebases/route.ts` — reconcile them in `after()`, capped, best-effort.
4. `test/guards/context-hook-callsites.test.ts` — enumerate `ingestItem` call sites against a
   reasoned allow-list.
5. `lib/projects/context/backfill.ts` + `lib/ingest/scheduler.ts` — `awaitingPartition` per team.
6. `docs/ARCHITECTURE.md` — the write-path row for the codebases route.

**Out, each with where it goes:**
- **The connector-leg at-ingest reconcile** — declined, §6.
- **Making `awaitingPartition` loud** — needs a threshold derived from observed values; next slice.
- **`lib/actions/handlers.ts:31`** — stays sweep-covered and allow-listed with its reason. It is an
  in-process action on the same host as the scheduler, ~1-2 min behind by §0b's measurement, and
  pulling it in would re-open the "which paths, on whose budget" question this slice exists to avoid.
- **Making the sweep's stale `"Cutoff = tick start"` comment true** — the comment is corrected in
  this slice (it is what produced two rounds of wrong design). Changing the *value* is not: taking
  the cutoff at tick start would make the sweep skip same-tick items and is the wrong direction.

---

## 5. Acceptance

Criteria are stated as **outcomes** — the reachability of the item — not as return shapes. Five
consecutive slices have had a criterion weaker than their own stated rule, every one of them phrased
as a return value.

- **AC1 — a pushed commit is reachable without a sweep (dm, `test/datamechanics/`):** ingest a commit
  through `ingestCodebaseScan`, run the ids it returns through `reconcileItemContext` with **no
  backfill pass at any point**, and the item appears in `visibleItemIds` for a member of the
  `general`-granted group. Asserted through the visible set, not by counting reconcile calls.
- **AC2 — a tier flip on re-scan is carried (dm):** re-ingest an existing commit whose `access` flips,
  arriving as `status: 'unchanged'` with `accessChanged: true`. Its id **is** returned, and after
  reconcile the item is in the target system project and **not** in the opposite one. Deleting the
  `|| result.accessChanged` term must redden this.
- **AC3 — an unchanged re-scan does no work (dm):** re-ingesting an identical commit returns **zero**
  ids, so a daily re-scan of an unchanged repository does not reconcile its whole history.
- **AC4 — the cap is counted, never silent (unit):** with `RECONCILE_AT_PUSH_MAX` exceeded, the
  reconciled count plus the deferred count equals the id count, and the deferred count is non-zero
  and recorded. A cap that drops ids without saying so fails this.
- **AC5 — a reconcile failure does not fail the push (http, `npm run test:http`):** with
  `reconcileItemContext` faulted, `POST /api/v1/codebases` still returns **201** with its documented
  body, and the recorded run is still `ok: true`. The write succeeded; only partitioning is deferred.
- **AC6 — the enumeration guard is closed (unit guard):** adding a fabricated production
  `ingestItem(` call site in a file on neither list **fails** the guard; removing
  `reconcileItemContext` from `app/api/v1/codebases/route.ts` **fails** it. Both directions asserted,
  because a guard that only fires on addition cannot see a deletion.
- **AC7 — `awaitingPartition` distinguishes zero from unknown (dm):** with an unpartitioned item
  present the recorded value is its exact count; with the counting query faulted it is **`null`**,
  and a converged team records **`0`**. Three distinct outcomes, three distinct values.
- **AC8 — the items route is untouched (unit guard + dm):** every existing assertion in
  `context-hook-callsites` still holds, and the items-route reconcile behaviour is unchanged.
- **AC9 — the push response contract is unchanged (http):** the `POST /api/v1/codebases` body still
  carries `{ status, contributions, issues }` with no new keys, and `ingest_runs` for `source: 'scan'`
  keeps its existing `meta` keys.

**What NO criterion above claims:** that the residual lag is zero everywhere. After this slice the
in-tick legs are still swept (1–2 min, §0b), `lib/actions/handlers.ts` is still swept, and a
`after()` that never runs is still swept. The guarantee is *"the largest push path no longer waits,
and the set of paths that do wait is enumerated"* — nothing more.

---

## 6. What is DECLINED, and why that is the finding

**Declined: reconciling inside the four connector legs of `lib/ingest/run.ts`** — the design of
`auditfix2-connector-reconcile-at-ingest.md` §2, twice BLOCKED, never built.

Not declined because it was blocked. Declined because **the problem it solves has been measured away**:

- The legs run *before* the sweep in the same tick (§0a), so their content is partitioned in that
  same tick — measured at **0.8–1.9 min** end to end (§0b).
- Building it means answering the four questions round 2 named — a scheduler-wide budget allocation,
  a lifecycle restructure of four importers around a team-scoped accumulator, a repair trigger from
  missing-context evidence, and a failure-visibility design — **for a 1.9-minute improvement**, on
  the one code path where getting the budget wrong re-creates TICKSTALL-1 (six outages in 14 days).
- Its third question is already answered better elsewhere: `selectCandidateItemIds` *is* the
  missing-context predicate, and it now runs to completion every tick in 2.6 s.

**Also refuted:** that document's own round-2 replacement proposal (change the sweep's cutoff) — §0a.
It would have been built against a premise that a single reading of `scheduler.ts:353` disproves.

**The process finding.** Both prior rounds attacked the *design* and neither re-derived the two
sentences the design stood on. Round 1 recorded the premise as *confirmed* — from a code comment
(*"Cutoff = tick start"*) that contradicts the line beneath it — and quoted a lag measurement across
a window in which the system's behaviour had changed by two orders of magnitude. A stale comment and
a mixed-regime average survived two adversarial reviews because neither review was pointed at them.

---

## 7. Risks

| risk | direction | mitigation |
|---|---|---|
| A 100-commit push reconciles 100 items in `after()` | serverless work after response; never blocks the push | `RECONCILE_AT_PUSH_MAX`, counted (AC4); sweep covers the remainder |
| The reconcile throws in `after()` | push already returned 201 | caught and logged, exactly as the items route does; sweep is the backstop (AC5) |
| The enumeration guard blocks an unrelated PR that adds an ingest path | build fails, loudly | that is the intent; the fix is one allow-list line **with a reason**, and the guard says so in its message |
| `awaitingPartition` is non-zero in steady state and gets read as a fault | misleading diagnosis | documented in §3d and in the code: items pushed *during* a pass are expected; no alarm is wired |
| `reconcileItemContext` contends with the sweep on the same item | double reconcile | idempotent by design and already true today for the items route; AUDITFIX-13 owns the ingest-writer race, which this does not widen (both writers here are reconcilers, which is the case AUDITFIX-4's pulled lock addressed) |

---

## 8. Terrain, for reproduction

All figures read-only against production via the Railway public proxy on 2026-08-22, team `aios`
(`73409b20-…`), the single self-hosted instance.

```sql
-- lag by day
select date_trunc('day', i.created_at)::date, count(*),
       percentile_cont(0.5) within group (order by extract(epoch from (u.created_at-i.created_at))/60)
  from items i join project_context_units u
    on u.source_item_id=i.id and u.unit_kind='item'
 where i.created_at > now() - interval '14 days'
   and split_part(i.path,'/',1) in ('github','commits','linear')
 group by 1 order by 1;

-- stage behaviour
select started_at, ok, meta from ingest_runs where source='context_backfill'
 order by started_at desc limit 12;

-- items reachable by nobody
select i.id, i.path, i.created_at from items i
 where not exists (select 1 from project_context_units u
                    where u.source_item_id=i.id and u.unit_kind='item');

-- push batch size
select count(*), avg(c), max(c) from (
  select date_trunc('minute', created_at) m, count(*) c from items
   where path like 'commits/%' and created_at > now() - interval '14 days' group by 1) b;
```

**Not measured:** how `awaitingPartition` behaves on a fleet with more than one team — prod has
exactly one, so the rotation and the per-team count are exercised only by the dm tier here.
