# Every writer of an item is enumerated, or the build fails — AUDITFIX-2, narrowed twice

**Status:** spec, **narrowed to a guard after two BLOCKED/DECLINE review rounds** (§9, §10).
The predecessor (`docs/design/auditfix2-connector-reconcile-at-ingest.md`, branch
`fix/auditfix-2-connector-reconcile`, two rounds, both BLOCKED, never built) rested on two false
premises, refuted here in §0. **This document's own first draft was then declined too** — the
push-route reconcile it proposed is DECLINED in §6, on evidence, and what remains is the half that is
sound: the writer inventory becomes build-enforced.

**Round 2's one sentence:** *"Build only a narrower, sound writer-inventory guard; the route change is
a best-effort latency optimization on an 8.6-minute-median self-healing path, and its folded 'budget'
creates unbounded aggregate work without durable observability."* Accepted. No code was written for
any of the three designs.

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

**Five rows, but they are not five independent writers:** rows 1-2 are *uncovered writers* (manual
and admin), rows 3-4 are *coverage failures* (a deferred team, a disabled poller), and row 5 is a
*latency multiplier* on all of them. Round 2 asked for that distinction so the scope argument is
mechanically countable.

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
(p90 33.9)**.

⚠️ **That was still not enough, and round 2 said why** (§10 B1): the join above omits the **grant**
conjunct `lib/access/enforce.ts:69-88,128-134` requires, uses `count(*)` so a second membership
weights the percentile, and pairs with a censorship check that only looks for a *unit* — so an item
with a unit and no membership reads as covered. **§8 carries the corrected query**, which is per-item,
left-joined throughout, and requires an active unit + a current include + a granted project. Its
answer: **`unreachable_now = 0` on every day, medians unchanged.** Three real methodological flaws,
each measuring zero on this deployment.

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

## 1. The defect that survives — and whose fix this slice declines

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

> **Every production call site that stores an item is CLASSIFIED — it either reconciles the item's
> context itself, or it is recorded as sweep-covered together with the latency that choice actually
> costs. A new, unclassified call site fails the build.**

This is deliberately a rule about **knowing**, not about latency. Two review rounds established that
the latency half needs an admission-control design this slice will not carry (§6).

**The failure mode this guard traces to is historical and checkable, and it is not the one I first
wrote down.** My first draft said "a route was added, took the un-reconciled path, and no build
failed." That is false, and the truth is worse. Checked against git:

| | |
|---|---|
| `lib/codebases/commits-to-items.ts` and its `ingestItem` call | **2026-06-25** (`a32b6923`) |
| `reconcileItemContext` **and** `test/guards/context-hook-callsites.test.ts` | **2026-08-11** (`d3cb8e2c`, #530, Phase A slice 5) |
| production `ingestItem` call sites present **on that day** | **12, across 6 files** — verified with `git grep` at `d3cb8e2c`: `lib/ingest/run.ts` ×7, `commits-to-items`, `actions/handlers`, `meetings/notes`, `meetings/merge`, `items/route` |
| call sites the guard shipped that day pins | **3** |

So the commits path was not overlooked at some later date; it was **never classified at all**. The
slice that introduced the context substrate wired three writers, left nine unwired, and shipped a
guard that pins exactly the three it had wired. That is characterization-by-construction — a test
asserting what the author just did rather than what the contract requires — which this repo's §2
operating principle forbids as the default, and it is why the guard has been green for eleven days
while 64 % of ingested volume takes the unclassified path.

**The falsifiable version of this slice's claim, therefore:** the guard as specified in §3 would have
**failed #530 itself**, forcing all twelve sites to be classified rather than three to be pinned.
That is the failure mode behind it, and CLAUDE.md §7 is satisfied by a real one rather than an
imagined one.

The rule's second clause is the part that keeps it honest. An allow-list entry that just says
"sweep-covered" is a shrug; one that says *"sweep-covered — same tick when the poller is on, next tick
otherwise, **indefinitely** when `INGEST_POLL_ENABLED=false`"* is a measurement someone can act on.

---

## 3. The design: a conservative closed-world inventory

### 3a. What the guard is, and — first — what it is NOT

⚠️ **It is not a proof that every stored item gets partitioned.** Round 2 was right to press this,
and the existing AST guard in this repo says the same about itself
(`test/guards/provenance-principal-callsites.test.ts:117-126` explicitly disclaims cross-module
resolution). A static walk cannot establish that a reconcile is *reached* on every branch — a call
inside `if (false)` satisfies any structural check, and a helper in an allow-listed file can be called
from a new unsafe path.

So the guard is scoped to the one question it can answer soundly:

> **Which files call `ingestItem`, and has each of them been classified by a human?**

It is a **closed-world inventory with a fail-closed default.** Its failure mode is a stale allow-list
entry — someone classifying a new site carelessly — not a silent escalation. That is a strictly better
failure mode than today's, which is *no one noticing at all*.

### 3b. The walk

Over production sources only (excluding `test/`, `**/*.test.ts`, `lib/ingest/fake-supabase.ts`,
`scripts/` — see §3d for why scripts are out), using the TypeScript AST, not text:

1. **Collect the local names that can reach `ingestItem`**, per file:
   - a named import from `@/lib/ingest`, **including an alias** (`import { ingestItem as writeItem }`);
   - a namespace import (`import * as ingest` → `ingest.ingestItem`, including the computed form
     `ingest["ingestItem"]`);
   - a **dynamic import** (`const { ingestItem } = await import("@/lib/ingest")`);
   - a **local rebinding** of any of the above (`const write = ingestItem`).
2. **Find every `CallExpression`** whose callee resolves to one of those names.
3. **Assert the containing file is in exactly one of two sets** — `RECONCILES` or `SWEEP_COVERED` —
   each entry carrying its reason **in the guard source**. A file in neither **fails the build**, with
   a message that names the file and tells the author to classify it rather than to silence it.
4. **A file may not be in both**, and every listed file must still contain a call — a stale entry for a
   deleted call site fails too, so the list cannot rot into fiction.
5. **For a `RECONCILES` file**, pin the *structural* contract the items route already ships and that
   the existing guard already asserts for it: the reconcile call appears **inside an `after(async …)`
   callback**. Nothing stronger is claimed (§3a).

**Bypasses the walk deliberately does NOT close**, listed rather than implied: a wrapper function
exported from an allow-listed module and called elsewhere; a call reached only through a runtime
indirection the parser cannot follow. Both are recorded in the guard's header as known gaps, because
a guard whose limits are undocumented gets trusted past them.

### 3c. Negative controls — the guard is mutation-tested against every historical evasion

Each of the following is fed to the guard as a synthetic source and **must fail** it. They are the
list of every way a text matcher was beaten in this repo, plus the three round 2 added:

| # | control | why it exists |
|---|---|---|
| 1 | plain `ingestItem(` in an unclassified file | the baseline |
| 2 | `import { ingestItem as writeItem }` then `writeItem(...)` | alias — beat AUDITFIX-1's guard |
| 3 | `import * as ingest` then `ingest.ingestItem(...)` | namespace |
| 4 | `ingest["ingestItem"](...)` | computed member — beat AUDITFIX-1's guard |
| 5 | `const { ingestItem } = await import("@/lib/ingest")` | dynamic import (round 2) |
| 6 | `const write = ingestItem; write(...)` | local rebinding (round 2) |
| 7 | a `RECONCILES` file whose only `reconcileItemContext` is **in a comment** | the paired-mention hole |
| 8 | a `RECONCILES` file whose reconcile is **outside** any `after()` | the "never inline" contract |
| 9 | an allow-list entry whose file no longer calls `ingestItem` | stale-entry rot |

Control 9 is the one that fails in the *deletion* direction. A guard that only fires on addition
cannot see a call site being removed and its entry left behind, and this repo has shipped that exact
class of decay before.

### 3d. The classification, with its real latency cost

The initial inventory — **12 call sites across 6 production files**, verified by the walk itself
rather than asserted:

| file | sites | class | reason, and the latency it actually carries |
|---|---|---|---|
| `app/api/v1/items/route.ts` | 1 | **RECONCILES** | `after()`, best-effort. Measured **0.0 min** median (41/41 workspace-CLI items partitioned inside 60 s) |
| `lib/meetings/notes.ts` | 1 | **RECONCILES** | reconciles explicitly |
| `lib/meetings/merge.ts` | 1 | **RECONCILES** | reconciles explicitly |
| `app/api/v1/codebases/route.ts` | 1 (via `commits-to-items`) | **SWEEP_COVERED** | ⚠️ the largest ingest volume — **64 %** of items, median **8.0–8.8 min**. A reconcile here is DECLINED in §6, not overlooked |
| `lib/codebases/commits-to-items.ts` | 1 | **SWEEP_COVERED** | as above |
| `lib/ingest/run.ts` | 7 | **SWEEP_COVERED** | same tick when scheduled (§0a, measured **0.8–1.9 min**); **next tick or later** via manual sync and the four admin actions; **indefinitely** with the poller off |
| `lib/actions/handlers.ts` | 1 | **SWEEP_COVERED** | ⚠️ **next-tick**, not same-tick. Round 2 corrected me here: `note.create` runs in the scheduler's *process*, which is not the scheduler's *sequential chain* — fired after the tick's cutoff it waits for the next one |

`scripts/` is excluded from the walk and stated as such: `scripts/seed-demo.ts` calls `ingestItem`
three times and is followed by an explicit drain (`docker/bootstrap.mjs:313,331`), and scripts are not
a deployed request surface. Excluding a directory silently is how an inventory becomes wrong, so the
exclusion and its reason live in the guard.

---

## 4. Scope

**In:**
1. `test/guards/context-hook-callsites.test.ts` — the AST inventory, the two classified sets with
   written reasons, the nine negative controls, and the existing three assertions kept.
2. `lib/ingest/scheduler.ts` — correct the **`"Cutoff = tick start"`** comment. It says stage start in
   code and tick start in prose, and that one wrong sentence produced two rounds of wrong design in
   the predecessor spec. Comment only; the value is correct and does not change.
3. `docs/ARCHITECTURE.md` — the context-partition row records the inventory and the three latency
   classes.

**Out, each with where it goes and why:**
- **The codebases-route reconcile** — DECLINED, §6. **AUDITFIX-16** if the latency is ever worth the
  admission-control design.
- **Manual sync + the four admin "Run … now" actions** — **AUDITFIX-14**. Needs item ids threaded back
  through four importers, the lifecycle restructure that BLOCKED the predecessor twice.
- **Wiring `findUnpartitionedItems` to something that runs automatically** — **AUDITFIX-15**. The
  count and the blocker already exist (`lib/projects/context/coverage.ts:36-67`,
  `lib/admin/access-health.ts:163-184`); what is missing is an automatic caller, since the only
  shipped caller is the CLI (`scripts/admin.ts:427`) — i.e. there is no **automatic or continuously
  surfaced** caller, which is the accurate negative.
- **A `.max()` on `recent_commits`** (`lib/api/schemas.ts:214`) — the route already loops over an
  unbounded array doing a full `ingestItem` per element **inline, before the response**
  (`lib/codebases/ingest.ts:180`). That is a pre-existing unbounded-work surface this slice neither
  creates nor fixes. **AUDITFIX-17.**

---

## 5. Acceptance

Every criterion is an outcome of running the guard, and each is **mutation-verified**: the mutation
named must redden *that* criterion and not merely something.

- **AC1 — an unclassified writer fails the build (unit guard):** a synthetic production file calling
  `ingestItem` and listed in neither set makes the guard **fail**, with a message naming the file.
- **AC2 — all nine evasions fail (unit guard):** each control in §3c, fed to the guard, **fails** it.
  Asserted in a loop with the control's name in the failure message, so a control that stops
  discriminating is visible rather than absorbed. *(One condition per fixture: each control trips
  exactly one rule, checked by asserting the specific message.)*
- **AC3 — the real tree passes, and the inventory is EXACT (unit guard):** run against the actual
  repository, the guard passes **and** the set of discovered files equals §3d's table — not a subset.
  A guard that finds nothing also "passes"; this is what makes it non-vacuous.
- **AC4 — a deleted call site cannot leave a stale entry (unit guard):** an allow-list entry naming a
  file with no `ingestItem` call **fails**. The deletion direction.
- **AC5 — a `RECONCILES` file must reconcile inside `after()` (unit guard):** moving
  `app/api/v1/items/route.ts`'s reconcile out of its `after()` callback **fails**; deleting the
  reconcile entirely **fails**.
- **AC6 — the three existing assertions still hold (unit guard):** the items-route `after()` pin, the
  scheduler leg pin, the admin-action pin, and the shared-core pin are unchanged and still red when
  mutated.
- **AC7 — the corrected comment matches the code (unit guard):** `lib/ingest/scheduler.ts` must not
  claim the cutoff is the tick start. Pinned, because the previous wording cost two design rounds and
  nothing would otherwise stop it being written back.

**What no criterion claims:** that every stored item is partitioned, that partitioning is timely, or
that a reconcile is reached on every branch. §3a says why a static walk cannot, and §6 says why the
timeliness work is not here.

---

## 6. What is DECLINED, and the evidence for declining it

### 6a. The connector-leg reconcile (the predecessor's design) — declined on cost

The legs are same-tick-partitioned under the scheduler, measured at **0.8–1.9 min** (§0b). Building
the alternative means the four questions the predecessor's round 2 named — a scheduler-wide budget
allocation, a lifecycle restructure of four importers around a team-scoped accumulator, a repair
trigger, and a failure-visibility design — on the one code path where a mis-sized budget re-creates
TICKSTALL-1 (**six outages in 14 days**). The cases where the legs genuinely are *not* covered are the
manual/admin ones, which are **AUDITFIX-14**.

**Also refuted:** that document's round-2 replacement proposal, *"make the sweep's cutoff not exclude
items created during the tick that ingested them"* — §0a. It would have been built against a premise
that one reading of `scheduler.ts:353` disproves.

### 6b. The codebases-route reconcile (THIS document's first draft) — declined on soundness

Three findings, each re-derived, that together say the sound version is a system and not a slice:

- **A per-callback deadline is not an allocation.** The route admits **60 requests/min per key**
  (`app/api/v1/codebases/route.ts:25-27`) with no fleet-wide cap, and one reconcile has no duration
  bound (`lib/projects/context/reconcile-item.ts:73-164`). With one key and a 5 s budget that is up to
  **300 callback-seconds started per minute**. Inventing `RECONCILE_AT_PUSH_BUDGET_MS` next to the
  existing `CONTEXT_BACKFILL_BUDGET_MS` reuses a *parser*, not an *allocation* — which is precisely
  the BLOCKER the predecessor's round 2 raised, **re-created a third time by a fold meant to fix it.**
  ⚠️ *Refuted in part, and it matters for how AUDITFIX-16 should be scoped:* the route **already**
  performs unbounded, request-blocking work over the same array — `recent_commits` has no `.max()`
  (`lib/api/schemas.ts:214`) and `projectCommitsToItems` runs a full `ingestItem` per element inline
  (`lib/codebases/ingest.ts:180`). So the reconcile is a constant-factor increase on an existing
  unbounded loop, not a new class. That argues for bounding the array (**AUDITFIX-17**) before adding
  work to it — not for adding the work now.
- **"Structured logs only" fails this document's own non-silent rule.** `lib/ingest/runs.ts:4-12` says
  in its own header that the durable row exists *because* container logs disappear from the
  application surface, and `railway.json` configures no drain, retention or queryable sink. A deadline
  hit every push for a week would leave every scan row `ok:true` and no surface showing it. The
  criterion I wrote would have proved only that `console` was called.
- **The fresh-team path reports success while nothing is reachable.** With system projects absent, the
  filtered predicate selects every id and `reconcileItemContext` returns **`{ok:true, skipped:true}`**
  (`lib/projects/context/reconcile-item.ts:47-83`). The callback would consume every id, log no
  remainder, and leave every commit unreachable — the fail-silent direction, on exactly the fresh-team
  case where the defect is total.

**What the decline costs, stated so it can be reversed knowingly:** the median wait for 64 % of
ingested volume stays at **8.6 min**, on a path that self-heals and currently has **zero** unreachable
items. That is the trade, and it is a product call rather than an engineering one.

### 6c. The process finding, which is the durable part

Across the predecessor and this document, **three folds in a row introduced a new defect while fixing
the named one** — the predecessor's budget fold re-created TICKSTALL-1, its cutoff proposal rested on
a premise a single line disproves, and this document's deadline fold re-created the allocation bug a
third time. Meanwhile:

- Both predecessor rounds attacked the **design** and neither re-derived the two sentences it stood
  on. One of those was a **code comment that contradicts the line beneath it**.
- This document's first draft then asserted its own unchecked negative — *"nothing anywhere counts
  this"* — about `findUnpartitionedItems`, which had already shipped with a **stronger** definition.

The common shape is not carelessness about code; it is **inherited prose treated as evidence.** The
one artefact that reliably broke the chain was going back to production and measuring — which is what
turned a "30–72 minute defect" into an 8.6-minute one already fixed by a different slice, and what
turned this slice from a system into a guard.

---

## 7. Risks

| risk | direction | mitigation |
|---|---|---|
| The guard blocks an unrelated PR that adds an ingest path | build fails, loudly | intended; the fix is one classified line **with a reason**, and the failure message says exactly that |
| Someone classifies a new site `SWEEP_COVERED` without thinking | the inventory records a wrong latency | unavoidable by construction (§3a); the entry requires a written reason and shows up in review, which is strictly better than today's silence |
| The AST walk misses an indirection (exported wrapper, runtime dispatch) | a call site escapes the inventory | listed as a known gap in the guard's own header rather than implied away (§3b) |
| The inventory table in §3d and the guard's sets drift apart | documentation lies | AC3 asserts **set equality** against the real tree, so drift fails the build |
| Declining the route work leaves 64 % of volume waiting 8.6 min | latency, self-healing, currently zero unreachable | stated in §6b as a reversible product call, with the measurement that would justify reversing it |

---

## 8. Terrain, for reproduction

Read-only against production via the Railway public proxy, 2026-08-22, team `aios`
(`73409b20-…`), the single self-hosted instance.

**The reachability query below is the one round 2 specified**, replacing an earlier version that
measured unit creation and inner-joined. It is per **item** (so a second membership cannot weight the
percentile), **left**-joined throughout (so an item with no unit or no membership is counted, not
dropped), and requires an **active** unit, a **current include**, and a project that appears in
**`project_groups`** — the exact conjunction `lib/access/enforce.ts:69-88,128-134` enforces.

```sql
with reach as (
  select i.id, i.created_at,
         min(m.created_at) filter (
           where u.state='active' and m.decision='include' and m.valid_to is null
             and g.project_id is not null
         ) as reachable_at
    from items i
    left join project_context_units u on u.source_item_id=i.id and u.unit_kind='item'
    left join project_context_memberships m on m.context_unit_id=u.id and m.team_id=u.team_id
    left join (select distinct project_id from project_groups) g on g.project_id=m.project_id
   where i.created_at > now() - interval '14 days'
     and split_part(i.path,'/',1) in ('github','commits','linear')
   group by 1,2
)
select date_trunc('day',created_at)::date, count(*),
       count(*) filter (where reachable_at is null) as unreachable_now,
       percentile_cont(0.5) within group (order by extract(epoch from (reachable_at-created_at))/60)
  from reach group by 1 order by 1;
```

**Result: `unreachable_now = 0` on every one of the twelve days, and the medians are identical to the
earlier series** — 08-10 1,579.4 · 08-16 84.6 · 08-19 19.6 · 08-21 **8.6**. So round 2's three
concrete failure modes for the earlier query (a unit with no membership; a membership into an
ungranted project; a membership-weighted percentile) are each **methodologically real and each
measures zero here.** The critique is accepted; the conclusion is unchanged, and this is the query
that supports it.

```sql
-- stage behaviour
select started_at, ok, meta from ingest_runs where source='context_backfill'
 order by started_at desc limit 12;
-- are manual syncs used at all?  ⚠️ see the caveat below
select trigger, source, count(*) from ingest_runs
 where started_at > now() - interval '30 days' group by 1,2 order by 1;
```

⚠️ **That last query cannot see the admin actions, and round 2 was right to say so.** `runManualSync`
records `trigger:"manual"` (`lib/ingest/manual-sync.ts:72-85`), but the four admin "Run … now" actions
call the connector functions **directly and record no connector run**
(`app/t/[team]/admin/integrations/actions.ts:160-166,191-197,210-216,229-236`). So "zero manual runs
in 30 days" covers the `/sync` command and `scripts/connectors.ts` **only**; admin-action frequency is
**unverified**, and §3d's classification says so rather than claiming latency it cannot measure.

**Also not measured:** behaviour on a fleet with more than one team — prod has exactly one, so the
rotation and the budget-deferral path in §0a are exercised only by the dm tier.

---

## 9. Round 1 — BLOCKED, and the fold cut a feature

**3 BLOCKER, 6 HIGH, 3 MEDIUM.** Every finding re-derived against the code before folding.

| # | finding | outcome |
|---|---|---|
| **B1** | §0a's refutation is too strong — manual sync, admin actions, deferred teams, a disabled poller | **CONFIRMED.** §0a narrowed; the disabled-poller case (`instrumentation.ts:55`) was new to me and is the sharpest: no backstop, not a slow one |
| **B2** | the lag query measures unit creation, not reachability, and is survivorship-biased | **CONFIRMED in method.** Re-run; see §10 B1 for the round-2 continuation and the final query |
| **B3** | every acceptance criterion passes with the defect intact (`cap = 1`) | **CONFIRMED.** Moot now — the route work is declined |
| **H1** | `status` is not evidence of context completeness; `accessChanged` is already handled inline | **CONFIRMED** (and see §10 H2 for the correction to *how* it is handled) |
| **H2** | `awaitingPartition` duplicates `findUnpartitionedItems`, with weaker semantics | **CONFIRMED. Cut.** My "nothing anywhere counts this" was false about a function already in the tree |
| **H3** | the deferred-count sink is undefined | **CONFIRMED**, and round 2 showed the proposed replacement was also wrong (§10 H4) |
| **H4** | a source-scan guard is defeatable | **CONFIRMED.** Became the AST walk that is now the whole slice (§3) |
| **H5** | `after()` is supported but not durable; a count does not bound aggregate work | **CONFIRMED.** The wall-clock fix was itself declined (§10 B3) |
| **H6** | AC9 misstates the shipped response contract | **CONFIRMED, and it caught a real bug** — `commitItemIds` would have shipped as public API. Moot now |
| **M1/M2/M3** | "under three seconds" contradicts its own table · the batch SQL is a minute-bucket proxy · "the only remaining path" holds only for HTTP push routes | **all CONFIRMED**, all corrected |

## 10. Round 2 — DECLINE, and the fold had re-created the bug a third time

**4 BLOCKER, 5 HIGH, 3 MEDIUM**, aimed at the fold rather than the design, which is where every
second-order defect in this program has landed.

| # | finding | outcome |
|---|---|---|
| **B1** | the reachability refutation still does not measure reachability — no grant conjunct, `count(*)` weighting, and the censorship check only left-joins *units*, so an item with a unit and no membership reads as covered | **CONFIRMED in method, REFUTED in effect.** Re-run with the exact predicate it specified: `unreachable_now = 0` on every day, medians unchanged (§8). All three failure modes are real and each measures zero here |
| **B2** | `CANDIDATE_SQL`'s sweep carve-outs become silent push omissions; the fresh-team path returns `{ok:true, skipped:true}` while nothing is reachable | **CONFIRMED**, and it is the fail-silent direction on the case where the defect is total. Contributes to the decline (§6b) |
| **B3** | a per-callback deadline is not an aggregate allocation — 60 req/min/key, no per-reconcile bound | **CONFIRMED. This is the fold re-creating the predecessor's own BLOCKER a third time.** Partially refuted on severity (the route is already unbounded inline) — which argues for AUDITFIX-17, not for shipping (§6b) |
| **B4** | AC1/AC5 cannot control a *child process* — `test:http` spawns `next start`, so a Vitest spy is in the wrong process, and polling is enabled with a 20 s first tick | **CONFIRMED** — I had reached the same conclusion independently before this round landed. The sound control is `INGEST_POLL_ENABLED=false` on the spawned server, not a spy |
| **H1** | the admin actions record no ingest run, so "zero manual runs" cannot establish they are latent; and `note.create` is next-tick, not same-tick | **CONFIRMED both.** An unmeasurable path must not be called latent (§8 caveat, §3d) |
| **H2** | §3a's "already partitioned before return" is false — `settleReclassification` **swallows** a failed reconcile | **CONFIRMED.** The attempt completes; the partitioning need not. The wording is corrected; the redundancy conclusion survives on different grounds |
| **H3** | the AST guard omitted dynamic imports, local rebinding and dead branches | **CONFIRMED.** All three are now negative controls 5, 6 and 8 (§3c), and §3a states plainly that reachability is not claimed |
| **H4** | "structured logs only" fails the spec's own non-silent rule — `runs.ts:4-12` says the durable row exists *because* logs disappear | **CONFIRMED**, from this repo's own header. Contributes to the decline (§6b) |
| **H5** | AUDITFIX-14 is a backlog, not a resolution of the disabled-poller case | **CONFIRMED.** §2's rule is now about classification, not a universal guarantee it cannot make |
| **M1** | "no production caller" is imprecise — there is a shipped CLI caller | **CONFIRMED**, reworded to "no automatic or continuously surfaced caller" |
| **M2** | "four exceptions" against a five-row table | **CONFIRMED**, corrected |
| **M3** | no further `commitItemIds` leak surface found; pin the explicit consumers | **CLEARED** — the only production caller is the route, and its run metadata is explicitly constructed |

**Nothing is built for the declined work. No code exists for any of the three designs.**
