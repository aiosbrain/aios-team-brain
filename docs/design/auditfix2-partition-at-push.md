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

So an item ingested by a connector leg **inside a scheduler tick** has `created_at < cutoff` and is
selected by `selectCandidateItemIds` in that very tick. There is no cutoff change to make; the
proposed "cheapest correct slice" has nothing to act on.

⚠️ **Stated exactly, because round 1 caught me overstating it.** That sentence covers the *scheduled*
chain, and nothing more. Same-tick partitioning is **not** guaranteed for:

| case | evidence | consequence |
|---|---|---|
| **manual sync** — the `/sync` chat command and `scripts/connectors.ts` | `lib/ingest/manual-sync.ts:41-57` calls all four connector functions with no backfill | waits for the next scheduled tick |
| **the four admin "Run … now" actions** | `app/t/[team]/admin/integrations/actions.ts:166,197,216,236` | same |
| **a budget-deferred team on a multi-team fleet** | `lib/projects/context/backfill.ts:240-248` — deferral promises service within `team_count` passes, not this one | waits one or more further ticks |
| **`INGEST_POLL_ENABLED=false`** | `instrumentation.ts:55` — the scheduler never starts | **no backstop at all**; unreachable indefinitely |
| **a configurable interval** | `lib/ingest/scheduler.ts:24` — `INGEST_POLL_MINUTES`, default 30 | the wait scales with the operator's setting |

The manual paths are **latent on this deployment, not live**: production has recorded **zero**
`trigger='manual'` ingest runs in 30 days (all 383 `scan` rows are `trigger: 'api'`). They are named
as a separate slice in §4, not silently folded in.

The load-bearing correction: §6 declines the connector-leg design **on cost**, not because its
problem was eliminated.

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

The stage is neither budget-truncated nor cursor-stranded. Recent passes drained in **2.6–6.2 s**
(2.6 s converged, 6.2 s with two items to fix) against a 30-minute tick.

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

### 0b-i. Two objections to that measurement, both raised in round 1, both re-run

**"It measures unit creation, not reachability."** Correct as stated — `project_context_units.created_at`
is not the moment a reader could reach the item; `lib/access/enforce.ts:49-88` requires an **active**
item-grain unit carrying a **current include-membership**. So the query was re-run through that join
instead:

```sql
join project_context_units u on … and u.state = 'active'
join project_context_memberships m on m.context_unit_id = u.id
                                  and m.decision = 'include' and m.valid_to is null
```

**The series is identical** — 08-10 1,579.4 / 08-16 84.6 / 08-19 19.6 / 08-20 19.7 / **08-21 8.6
(p90 33.9)**. On this deployment the unit and its include-membership land in the same reconcile, so
the two definitions do not diverge. The objection is methodologically right and empirically inert
here; the reachability form is the one quoted above, and the SQL in §8 is the reachability form.

**"An inner join censors items that never got partitioned, biasing the median low."** Re-run as a
**left join**, counting items with no unit per day:

| day | items | with unit | **missing** |
|---|---|---|---|
| 08-10 … 08-21 (every day) | 19…172 | all | **0** |
| 08-22 (in flight) | 1 | 0 | **1** |

Zero censored rows on every historical day. The only uncovered item is the live one in §1.

**What I concede outright: the causal claim.** TICKSTALL-2 slice A merged **2026-08-18** (#602,
`0fe6493b`) and the daily median fell 63.0 → 19.6 the following day. That is a correlation with a
merge date, not a proof of cause — volume, deploy cadence and the EXCLSHADOW-1/CLOSEMODE-1 changes
that followed are not separated. **The claim this spec relies on does not need the cause**: what it
needs is that the lag is 8.6 min *today* and the stage drains every tick *today*, both of which are
direct observations.

**What that leaves.** The connector legs are not the problem. One path is.

---

## 1. The defect that survives: two sibling push routes, one of which forgets

**Scoped precisely (round 1, MEDIUM 3):** `POST /api/v1/codebases` is the only **authenticated HTTP
push route** that stores items without an explicit reconcile. It is *not* the only sweep-dependent
writer. The full inventory, so nothing is implied by omission:

| writer | reconciles? |
|---|---|
| `POST /api/v1/items` | **yes** — `after()` (`app/api/v1/items/route.ts:162-181`) |
| `lib/meetings/notes.ts:118`, `lib/meetings/merge.ts:259` | **yes** — explicitly |
| `scripts/seed-demo.ts` (×3) | **yes** — followed by a drain (`docker/bootstrap.mjs:313,331`) |
| **`POST /api/v1/codebases`** | **no** — this slice |
| `lib/actions/handlers.ts:31` (`note.create`) | **no** — sweep-dependent, allow-listed with its reason (§4) |
| `lib/ingest/run.ts` ×7 | **no** — sweep-dependent; same-tick when scheduled (§0a), unbounded when manual |


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

> **A production path that stores an item either partitions it before it returns, within a stated and
> logged bound, or is on an enumerated allow-list recording why the sweep is sufficient for it.**

Three clauses, each of which round 1 forced:

- **"within a stated and logged bound"** — not "always". `after()` is non-durable and the work is
  unbounded in principle, so the honest promise is bounded (§3b). A bound that is not logged when it
  is hit is the silent truncation this slice exists to remove, not an instance of it.
- **"enumerated"** — the allow-list is the durable half. The sweep genuinely *is* sufficient for the
  scheduled connector legs (§0a) and a rule forbidding what is already correct is one nobody keeps.
  What must not happen is a path joining that set **without anyone deciding it should**.
- **"recording why"** — an allow-list entry with no reason decays into a list of exceptions.

Three qualifiers carried forward from earlier rounds that were right:

- **Never inline.** `test/guards/context-hook-callsites.test.ts:22` pins *"must run in after(), not
  inline (never blocks the push)"* for the items route. Making it inline anywhere reverses a shipped,
  tested contract.
- **Never fails the push.** A reconcile failure costs latency, not the write.
- **Not inside `ingestItem`.** That would make it inline for the items route (reversing the above) and
  would put every unit-test caller of `ingestItem` onto the context tables, which
  `lib/ingest/fake-supabase.ts` cannot model.

---

## 3. The design

### 3a. The trigger is missing context, not ingest status

**Round 1's HIGH 1 killed the status trigger, and re-deriving it made the case stronger than the
finding.** The first draft reused the items route's condition,
`result.status !== "unchanged" || result.accessChanged`. Both halves fail here:

- **`accessChanged` is already handled inline, so the term is vacuous.** `ingestItem` **awaits**
  `settleReclassification` on every access change (`lib/ingest/index.ts:374,530`), and that function
  **awaits `reconcileItemContext`** (`lib/ingest/reclassify.ts:113-118`). The item is therefore
  already partitioned before `ingestItem` returns. A criterion asserting "the flip is carried" would
  have passed with the term deleted — the seventh green-by-construction criterion in this program.
  (It is doubly moot for commits: `normalizeCommit` hardcodes `access: "team"`
  (`lib/codebases/commits-to-items.ts:75`), so a flip needs an operator to have reclassified the row
  by hand first.)
- **`status` is not evidence of context completeness.** `ingestItem` inserts the row and commits its
  SHA (`lib/ingest/index.ts:437-450,520-524`) and can still throw afterwards (the audit write,
  `539-557`). The next identical scan takes the `unchanged` path and reports `accessChanged: false`,
  so a status-based trigger excludes it **forever**. An operator deleting a unit or membership by
  hand produces the same permanent exclusion.

So: `projectCommitsToItems` returns **every** processed item id, and the route asks the substrate
which of them actually lack context.

**One owner for that question.** `lib/projects/context/backfill-candidates.ts` already computes
*"which items need work"* — three arms plus two carve-outs, whose agreement with `closeMembershipInto`
its own header warns must not drift. Rather than write a second definition, `CANDIDATE_SQL` gains an
optional id filter:

```sql
and ($7::uuid[] is null or i.id = any($7))
```

and `selectCandidateItemIds` an `ids?: string[]` option. **One SQL, one owner, no drift** — and the
existing carve-outs come along for free, which is correct: an explicit exclude-shadow or a retracted
unit is a state reconcile cannot repair, so reconciling it at push would burn the deadline on an item
that will never converge.

The steady-state consequence is the point: a daily re-scan of an unchanged repository returns its
commit ids, the predicate matches **none** of them, and the route does one query and no reconciles.

### 3b. The route reconciles them in `after()`, under a wall-clock deadline

Mirroring `app/api/v1/items/route.ts:162-181`, including the `try`/`catch` around the `after()`
**registration** — `after()` throws outside a request scope (the in-process handler tests), and a
throw there must not fail a push that already succeeded.

**`after()` is supported here but NOT durable, and the spec says so rather than implying otherwise.**
Production runs `next start` (`package.json:9`, `scripts/railway-start.sh:8`), for which Next
documents `after()` as supported
(`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md:236-245`) — but it runs
only within the route's configured duration (same file, `48-50`), and graceful shutdown depends on
the platform waiting, which `railway.json` does not configure
(`node_modules/next/dist/docs/01-app/02-guides/self-hosting.md:295-299`). Abrupt termination, a
timeout, or a deploy mid-callback loses the remaining work.

Therefore:

- **A wall-clock deadline (`RECONCILE_AT_PUSH_BUDGET_MS`), not only an item count.** Round 1 was
  right that a count cannot bound aggregate work: the route accepts **60 scans/min per key**
  (`app/api/v1/codebases/route.ts:25-27`), so several callbacks can be in flight at once and a
  per-callback item cap bounds none of them in time. The deadline is checked **after** each item, so
  every callback makes at least one item of progress.
- **Sequential, not `Promise.all`.** `reconcileItemContext` writes shared substrate rows; the p90
  batch is small; a fan-out buys nothing and adds a contention mode.
- **Whatever the deadline leaves is logged, then swept.** One structured line naming the count and
  the reason. Which leads to the constraint round 1 found:

**The durable sink is structured logs, and nothing else — stated because the first draft implied a
DB row that cannot exist.** `recordIngestRun` inserts the scan row *before* the response
(`app/api/v1/codebases/route.ts:53-64`) and returns no id (`lib/ingest/runs.ts:59-78`), so there is
nothing for the callback to update. Inventing a second run row would put a `source: 'scan'` failure
into the pipeline-health surface for work that is deferred, not broken. So: logs, and the existing
sweep. **AC4 pins the log line, not a row.**

**The internal field never reaches the wire.** `ingestCodebaseScan` returns
`{ codebase_id, metrics_id, contributions, issues }` (`lib/codebases/ingest.ts:230-235`) and the route
**spreads it whole** into the response (`route.ts:64`), so adding `commitItemIds` to that object would
publish an internal id array as public API. It is destructured off in the route and never serialized;
AC9 pins both the five existing keys and the absence of the new one.

### 3c. The guard enumerates the call sites — structurally, not by text

`test/guards/context-hook-callsites.test.ts` claims to pin "the §11 context-partition CALL SITES" and
pins **three named files**; it never enumerates `ingestItem`'s callers, which is exactly how the
codebases route got here.

**A text scan is not enough, and this repo already has the receipts.** AUDITFIX-1's guard was defeated
**three times** — by a literal, by an alias, by a named constant — each defeat a new *spelling* of one
act, until it was rewritten as a TypeScript AST walk
(`test/guards/provenance-principal-callsites.test.ts`). A `grep` for `ingestItem(` is defeated by
`import { ingestItem as writeItem }`, a namespace import, a re-exported wrapper, or a dynamic import;
and the paired check "does this file also mention `reconcileItemContext`" is satisfied by a comment or
dead code.

So the guard is an **AST walk** over production sources (excluding `test/`, `*.test.ts`,
`lib/ingest/fake-supabase.ts`):

1. Resolve every import of `ingestItem` from `@/lib/ingest` **including aliases**, namespace imports,
   and re-exports; find every `CallExpression` whose callee resolves to one.
2. Assert each containing file is in exactly one of two sets — **RECONCILES** or **SWEEP_COVERED** —
   each entry carrying a written reason in the guard itself. A file in neither **fails the build**.
3. For a RECONCILES file, assert the reconcile is reached from the same module by AST, not by the
   file merely containing the string.
4. Keep the known bypasses as **negative controls**: alias import, namespace call, re-exported
   wrapper, and a `reconcileItemContext` mention that appears only in a comment. Each must fail the
   guard when fed to it.

⚠️ **What it still cannot prove**, said plainly: that the reconcile is reached *for every item on
every branch*. That is AC1's job in the HTTP tier. The guard stops the **set of paths** drifting,
which no behavioural test can see.

### 3d. `awaitingPartition` is CUT — it duplicates a better definition that already exists

The first draft added a per-team count of "items with no active item unit", justified by the sentence
*"nothing anywhere counts this."* **That sentence is false, and it is a claim I introduced** — the
same class of unchecked assertion this document opens by refuting in its predecessor.

`lib/projects/context/coverage.ts:36-67` already ships `findUnpartitionedItems`, and its definition is
**strictly stronger** than the one proposed: an item counts as covered only with an *active*
item-grain unit carrying a *current include*-membership into a project **some group is granted**
(`coverage.ts:70-115`). The proposed count would have missed an item with a unit but no membership —
precisely a state `visibleItemIds` treats as unreachable. `assessAccessHealth` already turns a
non-zero result into a **blocker** (`lib/admin/access-health.ts:163-184`).

What is genuinely true is narrower and belongs to a different slice: **that blocker never runs**, because
`assessAccessHealth` has no production caller — its only invocation is a manual CLI command. Adding a
second, weaker metric with no consumer would not fix that; wiring the existing one to a scheduler or an
admin surface would, and needs a threshold nobody can yet derive (the steady-state value is non-zero by
design — items pushed *during* a pass). Named in §4 as the next slice, not smuggled into this one.

---

## 4. Scope

**In:**
1. `lib/codebases/commits-to-items.ts` — return every processed item id.
2. `lib/codebases/ingest.ts` — propagate them as an internal field.
3. `lib/projects/context/backfill-candidates.ts` — optional id filter on the existing predicate.
4. `app/api/v1/codebases/route.ts` — filter to items lacking context, reconcile in `after()` under a
   wall-clock deadline, log the remainder, never serialize the internal field.
5. `test/guards/context-hook-callsites.test.ts` — AST enumeration of `ingestItem` call sites against a
   reasoned allow-list, with the known bypasses as negative controls.
6. `docs/ARCHITECTURE.md` — the context-partition row gains the codebases route.

**Out, each with where it goes:**
- **The connector-leg at-ingest reconcile** — declined on cost, §6.
- **Manual sync and the four admin "Run … now" actions** — the real residual after this slice
  (`lib/ingest/manual-sync.ts:41-57`; `app/t/[team]/admin/integrations/actions.ts:166,197,216,236`).
  Latent on this deployment (**zero** `trigger='manual'` runs in 30 days) and fixing it needs item ids
  threaded back through four importers — the lifecycle restructure that BLOCKED the prior spec twice.
  **AUDITFIX-14.**
- **Wiring `findUnpartitionedItems` to something that runs** — §3d. **AUDITFIX-15.**
- **`lib/actions/handlers.ts:31` (`note.create`)** — stays sweep-covered and **allow-listed with its
  reason**: it is an in-process action on the same host as the scheduler, so it inherits §0a's
  same-tick behaviour whenever the poller is enabled.
- **`INGEST_POLL_ENABLED=false` having no backstop at all** — a real deployment hazard this slice
  *reduces* (the largest push path stops depending on the sweep) but does not close. Not silently
  accepted: it belongs with AUDITFIX-15's health work, where "the sweep is not running" is the thing
  being made visible.
- **Making the sweep's stale `"Cutoff = tick start"` comment true.** The **comment** is corrected here
  — it produced two rounds of wrong design. The **value** is not: taking the cutoff at tick start
  would make the sweep skip same-tick items, which is the wrong direction.

---

## 5. Acceptance

Round 1 demonstrated an implementation satisfying **every** criterion of the first draft while leaving
commits unreachable — set the cap to 1, reconcile the first id, record the rest as deferred; the
criteria never went through the route at all. That is the **sixth consecutive slice** in this program
whose criteria were weaker than its own stated rule, so the criteria below are rebuilt around
**observed reachability through the real HTTP surface**.

- **AC1 — a pushed commit is reachable with no sweep, end to end (http, `npm run test:http`):**
  `POST /api/v1/codebases` with two new commits against a live server, then poll until both appear in
  `visibleItemIds` for a member of the `general`-granted group. **No backfill is invoked at any point
  in the test** (asserted by spying the module, so the criterion cannot pass via the backstop). Runs
  the real route, the real `after()`, the real reconcile. *This criterion is what the round-1
  counterexample fails.*
- **AC2 — an already-partitioned re-scan does no reconcile work (dm):** re-ingest an identical,
  already-partitioned commit; the missing-context predicate returns **zero** ids and
  `reconcileItemContext` is **not called**. *Reversed from the first draft's AC3, which asserted
  "unchanged ⇒ no ids" and thereby blessed the permanent-exclusion hole in §3a.*
- **AC3 — an `unchanged` item that LACKS context is still repaired (dm):** an existing commit whose
  unit is deleted out from under it is returned by the predicate on the next scan and reconciled —
  even though `ingestItem` reports `status: 'unchanged'`, `accessChanged: false`. This is the hole a
  status trigger leaves open forever.
- **AC4 — the deadline is bounded, counted and logged, never silent (dm + unit):** with
  `RECONCILE_AT_PUSH_BUDGET_MS` set below the cost of the batch, reconciled + deferred equals the
  input count, deferred is non-zero, **one structured log line names it**, and at least one item was
  reconciled (the deadline is checked after each item, so a zero-budget push still makes progress).
- **AC5 — a reconcile failure does not fail the push (http):** with `reconcileItemContext` faulted,
  the route still returns **201** with its documented body and the recorded run is still `ok: true`.
- **AC6 — the enumeration guard is closed in BOTH directions and resists the known bypasses (unit
  guard):** a fabricated `ingestItem(` call in a file on neither list **fails**; removing the
  reconcile from `app/api/v1/codebases/route.ts` **fails**; and each of four negative controls —
  alias import, namespace call, re-exported wrapper, comment-only `reconcileItemContext` mention —
  **fails** when fed to the guard. A guard that only fires on addition cannot see a deletion, and one
  that only matches a spelling cannot see a rename.
- **AC7 — the id filter agrees with the unfiltered predicate (dm):** for a fixture spanning all three
  candidate arms plus both carve-outs, `selectCandidateItemIds({ids})` returns exactly the
  intersection of the unfiltered result with `ids`. This is what makes "one owner, no drift" a fact
  rather than an intention.
- **AC8 — the items route and the existing guard assertions are untouched (unit guard + dm).**
- **AC9 — the HTTP contract is unchanged and the internal field never ships (http):** the response
  body carries exactly `{ status, codebase_id, metrics_id, contributions, issues }` — all five, since
  `codebase-health.datamechanics.test.ts:408-424` consumes two of them — and **no `commitItemIds`
  key**. `ingest_runs` for `source: 'scan'` keeps its existing `meta` keys.

**What no criterion above claims.** That the residual is zero. After this slice, manual/admin syncs,
`note.create`, the scheduled connector legs, a deferred team, a lost `after()`, and anything past the
deadline are all still swept — and on `INGEST_POLL_ENABLED=false` there is no sweep. The guarantee is
*"the largest push path no longer depends on the sweep, the bound is logged when hit, and the set of
paths that do depend on it is enumerated"* — nothing more.

---

## 6. What is DECLINED, and why that is the finding

**Declined: reconciling inside the four connector legs of `lib/ingest/run.ts`** — the design of
`auditfix2-connector-reconcile-at-ingest.md` §2, twice BLOCKED, never built.

**On cost, not because the problem vanished.** Round 1 was right to strike the stronger claim: the
legs are same-tick-partitioned only under the scheduler, and §0a lists four cases where they are not.
The decline rests on what building it *buys*:

- For the case that actually runs on this fleet — the scheduled tick — the measured improvement is
  **1.9 minutes**, and it comes at the price of the four questions round 2 of the prior spec named: a
  scheduler-wide budget allocation, a lifecycle restructure of four importers around a team-scoped
  accumulator, a repair trigger, and a failure-visibility design. On the one code path where a
  mis-sized budget re-creates TICKSTALL-1 — **six outages in 14 days**.
- Its repair-trigger question is already answered better elsewhere: `selectCandidateItemIds` **is** the
  missing-context predicate, it runs to completion every tick in 2.6 s, and §3a now reuses it.
- The cases where the legs genuinely are not covered are the **manual/admin** ones — which are
  **AUDITFIX-14**, are latent (zero manual runs in 30 days), and want the same id-threading work. If
  that slice is ever built, the connector legs come with it, correctly scoped and for a reason that is
  measured rather than assumed.

**Also refuted:** that document's round-2 replacement proposal — *"make the sweep's cutoff not exclude
items created during the tick that ingested them"* — §0a. It would have been built against a premise
that a single reading of `scheduler.ts:353` disproves.

**The process finding.** Both prior rounds attacked the *design*; neither re-derived the two sentences
the design stood on. Round 1 recorded the premise as **confirmed** — from a code comment
(*"Cutoff = tick start"*) that contradicts the line beneath it — and quoted a lag average across a
window in which the system's behaviour had changed by two orders of magnitude. A stale comment and a
mixed-regime average survived two adversarial reviews because neither review was pointed at them.
**And this document repeated the class in its own first draft** (§3d): "nothing anywhere counts this",
asserted without grepping, about a function that had shipped.

---

## 7. Risks

| risk | direction | mitigation |
|---|---|---|
| A large push reconciles many items in `after()` | work after the response; never blocks the push | wall-clock deadline, remainder logged + swept (AC4); the missing-context filter makes the steady-state batch empty (AC2) |
| `after()` never completes — timeout, abrupt termination, deploy mid-callback | items stay unpartitioned | non-durability stated in §3b; sweep is the backstop **when the scheduler is enabled**; `INGEST_POLL_ENABLED=false` is named as an open hazard (§4) |
| 60 pushes/min per key ⇒ concurrent callbacks | aggregate work unbounded by a per-callback item cap | the bound is wall-clock per callback, and the filter means a repeat scan does nothing |
| The reconcile throws in `after()` | push already returned 201 | caught + logged, as the items route does (AC5) |
| The enumeration guard blocks an unrelated PR adding an ingest path | build fails, loudly | intended; the fix is one allow-list line **with a reason**, and the guard's message says so |
| The id filter and the sweep's predicate drift apart | an item passes at push and is swept anyway, or vice versa | they are the **same SQL** with one extra parameter, pinned by AC7 |
| Push-time reconcile races the sweep on the same item | double reconcile | idempotent, and already true today for the items route; the ingest-writer race is **AUDITFIX-13** and this does not widen it — both writers here are reconcilers |

---

## 8. Terrain, for reproduction

All figures read-only against production via the Railway public proxy on 2026-08-22, team `aios`
(`73409b20-…`), the single self-hosted instance.

```sql
-- REACHABILITY lag by day (active unit + current include — not unit creation alone)
select date_trunc('day', i.created_at)::date, count(*),
       percentile_cont(0.5) within group (order by extract(epoch from (m.created_at-i.created_at))/60)
  from items i
  join project_context_units u on u.source_item_id=i.id and u.unit_kind='item' and u.state='active'
  join project_context_memberships m on m.context_unit_id=u.id
                                    and m.decision='include' and m.valid_to is null
 where i.created_at > now() - interval '14 days'
   and split_part(i.path,'/',1) in ('github','commits','linear')
 group by 1 order by 1;

-- CENSORING check: the same window as a LEFT join, counting items with no unit
select date_trunc('day', i.created_at)::date, count(*), count(u.id),
       count(*) - count(u.id) as missing
  from items i left join project_context_units u
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

-- are manual syncs used at all?
select trigger, source, count(*) from ingest_runs
 where started_at > now() - interval '30 days' group by 1,2 order by 1;
```

⚠️ **The push-batch figures are a MINUTE-BUCKET PROXY, not a per-request measurement**, and round 1
was right to flag that they must not size a correctness lever. Grouping commit-item creation by minute
merges two one-item pushes in the same minute and splits one request across a boundary. They are
quoted in §1 as an order-of-magnitude sanity check only; the actual bound in §3b is **wall-clock**,
which does not depend on knowing the batch distribution.

**Not measured:** behaviour on a fleet with more than one team — prod has exactly one, so the rotation
and the deferral path in §0a are exercised only by the dm tier.

---

## 9. Round 1 — BLOCKED, and what it changed

**3 BLOCKER, 6 HIGH, 3 MEDIUM.** Every finding was re-derived against the code before folding; one is
refuted in part, with the measurement that refutes it.

| # | finding | outcome |
|---|---|---|
| **B1** | §0a's refutation is too strong, so §6's blanket decline does not hold — manual sync, admin actions, deferred teams, a disabled poller | **CONFIRMED.** §0a narrowed to the scheduled chain with the four exceptions tabled; §6 re-argued on cost. The disabled-poller case (`instrumentation.ts:55`) was new to me and is the sharpest: it means *no* backstop, not a slow one. |
| **B2** | the lag query measures unit creation, not reachability, and is survivorship-biased | **CONFIRMED in method, REFUTED in effect.** Re-run through the reachability join: identical series. Re-run as a left join: **zero** censored rows on every historical day. The causal attribution to TICKSTALL-2 is conceded to correlation (§0b-i). |
| **B3** | every acceptance criterion passes with the defect intact (`cap = 1`) | **CONFIRMED.** The counterexample works exactly as described. AC1 is now an end-to-end HTTP test through the real route and `after()`, with the backfill spied to prove it did not help. |
| **H1** | `status` is not evidence of context completeness; `accessChanged` is already reconciled inline | **CONFIRMED, and worse than reported** — the `accessChanged` term is *vacuous*, so the criterion built on it was green by construction. Replaced by a missing-context predicate (§3a). |
| **H2** | `awaitingPartition` duplicates `findUnpartitionedItems`, with weaker semantics | **CONFIRMED. Cut.** My "nothing anywhere counts this" was false about a function that had shipped (§3d). |
| **H3** | the deferred-count sink is undefined; the scan row is written before `after()` | **CONFIRMED.** Structured logs only, stated as such; AC4 pins the line (§3b). |
| **H4** | a source-scan guard is defeatable — alias, namespace, wrapper, dynamic import, dead-code mention | **CONFIRMED.** Rewritten as an AST walk with the four bypasses as negative controls (§3c, AC6). |
| **H5** | `after()` is supported but not durable; a count does not bound aggregate work at 60 req/min | **CONFIRMED.** Wall-clock deadline; non-durability and the conditional backstop stated (§3b, §7). |
| **H6** | AC9 misstates the shipped response contract | **CONFIRMED, and it caught a real bug** — the route spreads the ingest result whole, so `commitItemIds` would have shipped as public API. Destructured off; AC9 pins all five keys plus its absence. |
| **M1** | "under three seconds" contradicts the 6.157 s row in the same table | **CONFIRMED**, corrected to 2.6–6.2 s. |
| **M2** | the batch-size SQL is a minute-bucket proxy and must not size a correctness lever | **CONFIRMED**, labelled as such; the bound became wall-clock, which does not depend on it (§8). |
| **M3** | "the only remaining path" holds only for authenticated HTTP push routes | **CONFIRMED**, full writer inventory tabled (§1). |

**Nothing is built. No code exists for this slice.**
