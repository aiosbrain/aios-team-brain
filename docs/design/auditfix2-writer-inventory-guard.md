# Every writer of an item is enumerated, or the build fails — AUDITFIX-2, narrowed twice

**Status:** spec, **narrowed to a guard after two BLOCKED/DECLINE review rounds** (§9, §10).
The predecessor (`docs/design/auditfix2-connector-reconcile-at-ingest.md`, branch
`fix/auditfix-2-connector-reconcile`, two rounds, both BLOCKED, never built) rested on two false
premises, refuted here in §0. **This document's own first draft was then declined too** — the
push-route reconcile it proposed is DECLINED in §6, on evidence, and what remains is the half that is
sound: the writer inventory becomes build-enforced.

**Round 2's one sentence:** *"Build only a narrower, sound writer-inventory guard; the route change is
a best-effort latency optimization on an 8.6-minute-median self-healing path, and its folded 'budget'
creates unbounded aggregate work without durable observability."* Accepted.

**Round 3 then BLOCKED the narrowed guard itself** (§11) — *"Build a smaller canonical-module
direct-call inventory only after making its limits honest: it is a useful review tripwire that would
have caught the commit-writer PR, but it neither inventories writer entry surfaces nor enforces
partitioning or latency."* Three BLOCKERs, and one of them found the design **unsatisfiable against
the real tree**. Folded in §2-§5. No code has been written for any of the four designs.

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

## 2. The rule — stated as exactly what the build enforces

> **Every file that calls `ingestItem` directly, anywhere in the deployed tree or in a supported
> operator command, carries a CLASSIFICATION enum and a non-empty human rationale in the guard
> source. A file that calls it and is unclassified fails the build; so does a classification whose
> file no longer calls it.**

**That is the whole enforced invariant, and round 3 was right to make me say so.** Earlier drafts of
this section also promised that each entry records *"the latency that choice actually costs"* — but
nothing validates a rationale, a claimed latency, or poller dependence. A writer classified
`SWEEP_COVERED — same tick, 1 minute` passes the build even when it is an HTTP path on an instance
with polling disabled. **The latency column in §3d is review-only documentation.** Calling it part of
the rule would have been the same species of overstatement this document has now corrected three
times.

**What this is:** a build-enforced review tripwire on the *set of direct writers*.
**What this is not:** an access-substrate control. It does not prove partitioning happens, that a
`reconciles` call is reachable, or that any latency claim is true.

### 2a. The failure mode behind it — third statement, and this one is checked

CLAUDE.md §7: *"a guard with no failure mode behind it is ceremony."* So the claim has to be
falsifiable, and my first two attempts at it were both wrong:

| attempt | claim | verdict |
|---|---|---|
| 1 | *"a route was added, took the un-reconciled path, and no build failed"* | **false** — `app/api/v1/codebases/route.ts` landed **2026-06-17** (`bc613732`) writing no items at all |
| 2 | *"the guard would have failed #530"* | **true but imprecise** — and it implied the guard protects against new routes, which round 3 showed it does not |
| 3 | below | checked against git, with the limit stated |

**The accurate version.** The direct writer is `projectCommitsToItems`
(`lib/codebases/commits-to-items.ts:117`), added **2026-06-25** (`a32b6923`) — eight days after the
route, and seven weeks before the context substrate existed. Then:

| | |
|---|---|
| `reconcileItemContext` **and** `test/guards/context-hook-callsites.test.ts` | **2026-08-11** (`d3cb8e2c`, #530) |
| direct `ingestItem` call sites present that day | **12, across 6 files** (`git grep` at `d3cb8e2c`) |
| call sites the guard shipped that day pins | **3** |

So the guard specified here **would have failed `a32b6923`** (a new direct caller in an unclassified
file) **and would have failed #530** (nine existing direct callers left unclassified while three were
pinned). The second is the interesting one: #530 shipped a test asserting what its author had just
wired rather than what the contract required — characterization-by-construction, which CLAUDE.md §2
forbids as the default — and that is why it has been green for eleven days while 64 % of ingested
volume takes an unclassified path.

⚠️ **And the limit, stated because round 3 found it and §3a would otherwise only imply it: this guard
would NOT catch a new HTTP route that calls an existing, already-classified wrapper.** Add a second
route calling `ingestCodebaseScan` and no new direct call site appears; every criterion below still
passes. Entry surfaces are documented in §3e and are **not** build-enforced. A tripwire on direct
writers is what is soundly checkable without a whole-program call graph; claiming more would be the
overstatement again.

---

## 3. The design: a canonical-module direct-call inventory

### 3a. What it is, and first what it is not

A static walk cannot establish that a reconcile is *reached* on every branch — a call inside
`if (false)` satisfies any structural check — and this repo's existing AST guard says the same about
itself (`test/guards/provenance-principal-callsites.test.ts:117-126` explicitly disclaims cross-module
resolution). So the guard answers only:

> **Which files call `ingestItem` directly, and has a human classified each of them?**

**Fail-closed by default**, with the undecidable cases named rather than assumed away (§3c).

### 3b. Canonical module resolution — not a literal specifier match

**Round 3's BLOCKER 3, and the escape is already in the tree.** An earlier draft keyed the walk on the
literal specifier `@/lib/ingest`. `tsconfig.json:21-23` maps `@/*` to `./*`, so `@/lib/ingest`,
`@/lib/ingest/index`, `./ingest`, `../lib/ingest` and `../ingest/index` are all the same module — and
`scripts/seed-demo.ts:13` **already imports it relatively** (`from "../lib/ingest"`). A literal
matcher would have missed a writer that exists today, and AC3's set-equality would then have
*certified* the incomplete set as complete.

So every specifier — static import, `export … from`, `await import(...)`, `require(...)` — is resolved
to an absolute path (applying the `@/*` → repo-root mapping, and directory→`index.ts` resolution) and kept only
if it resolves to **`lib/ingest/index.ts`**, the canonical module. One level of re-export barrel is
followed; a second level **fails closed** with a message saying so (there is no such barrel today —
asserted by AC8, so the day one appears the guard says it cannot see through it rather than silently
missing it).

### 3c. The binding forms, and what happens when provenance is undecidable

Supported, resolved syntax-only (no type checker — the existing guard's approach, and enough for
these):

| form | example |
|---|---|
| named import | `import { ingestItem } from "@/lib/ingest"` |
| aliased named import | `import { ingestItem as writeItem } from "../lib/ingest"` |
| namespace member | `import * as ingest` → `ingest.ingestItem(...)` / `ingest["ingestItem"](...)` |
| dynamic-import destructure | `const { ingestItem } = await import("@/lib/ingest")` — the `ImportExpression` argument is a string literal and the binding pattern is inspectable, so this is decidable syntax-only |
| direct alias | `const write = ingestItem` where the initializer is a canonical binding |

**Everything else fails closed, loudly.** If an identifier's initializer traces to a canonical ingest
binding through any construct not in that table — reassignment, a conditional alias, storage in an
object or array, a chained alias, or a shadowed redeclaration — the guard **fails** and names the
construct and the file. Round 3's point was that "local rebinding" is not decidable in general and my
draft gave no behaviour for the undecidable case. It does now, and the direction is refusal:
`REFUSED: unsupported ingestItem binding in <file>:<line> (<construct>) — express it as a direct
import or classify the file explicitly`.

That refusal is itself pinned (AC2, control 10), because a fail-closed branch nobody tests is the
branch that quietly becomes fail-open.

### 3d. Three obligation classes, not two — the design was unsatisfiable with two

**Round 3's BLOCKER 2, and it was fatal to the previous draft.** It required every `RECONCILES` file
to reconcile inside `after(async …)`. **Both meeting writers reconcile inline, deliberately**, and one
of them must:

- `lib/meetings/notes.ts:141` — inline, so the uploader's own meeting does not 404 until the sweep;
  its comment explicitly contrasts itself with the items route (*"the HTTP items route does it in
  `after()`"*).
- `lib/meetings/merge.ts:287` — inline and **load-bearing**: it `throw`s and aborts the merge if the
  reconcile fails, *before* re-pointing the survivor. Deferring it to `after()` would break the merge's
  ordering contract.

Implemented literally, AC3 could never have passed. So the enum has three values, each with the
structural check that is true for it:

| class | structural check | members |
|---|---|---|
| `RECONCILES_AFTER_RESPONSE` | an awaited `reconcileItemContext` **inside** an `after(async …)` callback | `app/api/v1/items/route.ts` |
| `RECONCILES_INLINE` | an awaited `reconcileItemContext` in the module, **not** inside `after()` | `lib/meetings/notes.ts`, `lib/meetings/merge.ts` |
| `SWEEP_COVERED` | none beyond a non-empty rationale | the rest |

The inventory — **15 direct call sites across 7 files**, discovered by the walk and asserted equal to
this table (AC3):

| file | sites | class | rationale, and its review-only latency note |
|---|---|---|---|
| `app/api/v1/items/route.ts` | 1 | `RECONCILES_AFTER_RESPONSE` | never blocks the push; measured **0.0 min** (41/41 inside 60 s) |
| `lib/meetings/notes.ts` | 1 | `RECONCILES_INLINE` | the uploader must not 404 on their own meeting |
| `lib/meetings/merge.ts` | 1 | `RECONCILES_INLINE` | must complete before the survivor is re-pointed; failure aborts the merge |
| `lib/codebases/commits-to-items.ts` | 1 | `SWEEP_COVERED` | ⚠️ **64 % of ingested volume**, median **8.0–8.8 min**. A reconcile here is DECLINED in §6, not overlooked |
| `lib/ingest/run.ts` | 7 | `SWEEP_COVERED` | same tick when scheduled (measured **0.8–1.9 min**); next tick or later via manual sync and the four admin actions; **indefinitely** with the poller off |
| `lib/actions/handlers.ts` | 1 | `SWEEP_COVERED` | ⚠️ reached from **`POST /api/v1/actions`** (`app/api/v1/actions/route.ts:39` → `runAction`) and from the admin approval path — **not** the scheduler chain. Next tick or later; no backstop with the poller off |
| `scripts/seed-demo.ts` | 3 | `SWEEP_COVERED` | ⚠️ drained **only** under `docker/bootstrap.mjs:313,331`. `npm run dev:seed`, `scripts/e2e.sh` and `scripts/dev-test-setup.sh` invoke it with **no drain** |

Two entries corrected by round 3 rather than by me, and both were rationales I asserted without
checking — the same habit §6c names:

- **`lib/actions/handlers.ts`.** I wrote *"runs in the scheduler's process"*. It is an HTTP/admin
  writer outside the scheduler chain entirely. Being in the same process is not being in the same
  sequential `await` chain.
- **`scripts/`.** I excluded the directory on the grounds that seeding *"is followed by a drain"*.
  Only the Docker bootstrap drains. `npm run dev:seed` (`package.json:20`) runs the script directly,
  and against an enforcing instance with polling disabled its items stay unreachable. **The exclusion
  is withdrawn — `scripts/` is in the walk.** A rule that claims every writer while excluding a
  supported writer command is the kind of quiet narrowing this whole document exists to stop.

### 3e. Entry surfaces — documented, NOT enforced

Recorded so the gap in §2a is visible rather than latent. **Nothing below is build-checked.**

| entry surface | reaches the writer via |
|---|---|
| `POST /api/v1/codebases` | → `ingestCodebaseScan` → `projectCommitsToItems` → `ingestItem` |
| `POST /api/v1/actions` | → `runAction` → `note.create` → `ingestItem` |
| admin approval action | → `resolveApproval` → `runAction` → … |
| the four admin "Run … now" actions | → `runSlackIngestion` etc. → `ingestItem` (and record **no** ingest run) |
| `/sync` chat command, `scripts/connectors.ts` | → `runManualSync` → the same four |

Closing this properly needs a whole-program call graph from every route/action entry point. That is
**AUDITFIX-18** and is deliberately not attempted here.

---

## 4. Scope

**In:**
1. `test/guards/context-hook-callsites.test.ts` — the canonical-resolution AST inventory, three
   obligation classes with written rationales, the fail-closed refusal, the negative controls **and
   their positive twins**, and the four existing assertions kept.
2. `lib/ingest/scheduler.ts` — correct the **`"Cutoff = tick start"`** comment (it says stage start in
   code, tick start in prose, and that one sentence produced two rounds of wrong design).
   **Comment only, and with no guard or acceptance criterion attached** — round 3 was right that
   pinning one wrong phrase cannot make a future comment accurate, and that the writer-inventory guard
   should not acquire a second, unrelated prose matcher.
3. `docs/ARCHITECTURE.md` — the context-partition row records the inventory and the three classes.

**Out, each with where it goes:**
- **The codebases-route reconcile** — DECLINED, §6b. **AUDITFIX-16.**
- **Entry-surface (call-graph) enforcement** — **AUDITFIX-18**, §3e.
- **Manual sync + the four admin "Run … now" actions** — **AUDITFIX-14.**
- **An automatic caller for `findUnpartitionedItems`** — **AUDITFIX-15.** The count and the blocker
  exist (`lib/projects/context/coverage.ts:36-67`, `lib/admin/access-health.ts:163-184`); the only
  shipped caller is the CLI (`scripts/admin.ts:427`), i.e. there is no **automatic or continuously
  surfaced** caller.
- **A `.max()` on `recent_commits`** (`lib/api/schemas.ts:214`) — **AUDITFIX-17**, and §6b now records
  it as raising the urgency of bounding that input rather than as a refutation of anything.

---

## 5. Acceptance

Each criterion is an outcome of running the guard, and each is **mutation-verified**: the named
mutation must redden *that* criterion, not merely something.

- **AC1 — an unclassified writer fails the build (unit guard):** a fixture with a canonical
  `ingestItem` import and a real call, in neither class, **fails**, and the message names the file.
- **AC2 — every evasion fails, and every innocent twin passes (unit guard):** the table in §5a, run as
  a loop asserting **the exact diagnostic** for each row. Both directions are in one criterion on
  purpose: a guard that fails everything also "catches every evasion".
- **AC3 — the real tree passes and the inventory is EXACT (unit guard):** run against the actual
  repository the guard passes, **and** the discovered file set equals §3d's seven files with their
  site counts — not a subset. ⚠️ *Round 3 showed this criterion is only as strong as the recognizer
  behind it: with a literal-specifier walk, set-equality certifies an incomplete set as complete. It
  is §3b's canonical resolution that gives AC3 its meaning, and control 4 in §5a is what pins that.*
- **AC4 — a stale entry fails (unit guard):** a classification naming a file with no `ingestItem` call
  **fails**. The deletion direction, which an addition-only guard cannot see.
- **AC5 — each class's structural check is enforced and is DISTINCT (unit guard):** moving the items
  route's reconcile out of its `after()` **fails**; moving a meeting writer's reconcile *into* an
  `after()` **fails**; deleting a reconcile from any `RECONCILES_*` file **fails**. The middle one is
  what proves the three classes are not one class wearing three names.
- **AC6 — the four existing assertions still hold (unit guard)**, each still red when mutated.
- **AC7 — an undecidable binding is REFUSED, not ignored (unit guard):** a fixture aliasing a
  canonical import through an unsupported construct makes the guard **fail** with the refusal message,
  proving the fail-closed branch exists and is reached.
- **AC8 — a second-level re-export barrel is refused (unit guard):** a fixture re-exporting a
  re-export **fails** with the "cannot see through" message. There is no such barrel today, so without
  this the branch would be unreachable and untested.

### 5a. Controls — every fixture self-contained, every twin explicit

**Round 3's HIGH 4: four of my nine controls tested nothing.** Control 1 had no import binding (so a
binding-aware guard *should* ignore it), control 4 showed a namespace call with no namespace import,
control 5 was a dynamic import **with no call at all** — not a writer, and it should pass — and
control 6 rebound an identifier of unstated origin. Every fixture below carries a canonical import
**and** an actual call, and each asserts its own exact message.

| # | fixture | expected |
|---|---|---|
| 1 | canonical named import + call, unclassified | **fail** — unclassified |
| 2 | `import { ingestItem as writeItem } from "@/lib/ingest"` + `writeItem(...)` | **fail** |
| 3 | `import * as ingest from "@/lib/ingest"` + `ingest.ingestItem(...)` | **fail** |
| 4 | `import { ingestItem } from "../lib/ingest"` (relative — the live escape) + call | **fail** |
| 5 | `import { ingestItem } from "@/lib/ingest/index"` + call | **fail** |
| 6 | `const { ingestItem } = await import("@/lib/ingest")` + call | **fail** |
| 7 | `const write = ingestItem; write(...)` after a canonical import | **fail** |
| 8 | `import * as ingest` + `ingest["ingestItem"](...)` | **fail** |
| 9 | classified `RECONCILES_AFTER_RESPONSE` whose `reconcileItemContext` appears **only in a comment** | **fail** |
| 10 | canonical import aliased through an unsupported construct (object storage) | **fail — REFUSED** (AC7) |
| 11 | a classification entry whose file has no call | **fail — stale** (AC4) |
| **T1** | a *locally defined* function also named `ingestItem`, no canonical import, called | **pass** — the binding-awareness twin |
| **T2** | `await import("@/lib/other")` destructured, no `ingestItem` call | **pass** — a dynamic import is not a writer |
| **T3** | a canonical import used only in a **type position** (`typeof ingestItem`) | **pass** — not a call |
| **T4** | the real repository | **pass** (AC3) |

Controls 4 and 5 are the ones round 3's BLOCKER 3 demands, and control 4 mirrors a file that exists
today. T1–T3 are the positive twins: without them a guard that simply always fails would satisfy every
row above.

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
  ⚠️ *I called this "partially refuted" and round 3 struck that down, correctly.* The route **does**
  already perform unbounded, request-blocking work over the same array — `recent_commits` has no
  `.max()` (`lib/api/schemas.ts:214`) and `projectCommitsToItems` runs a full `ingestItem` per element
  inline (`lib/codebases/ingest.ts:180`). But an existing unbounded **request** loop does not turn a
  per-callback deadline into a **fleet allocation**: the declined reconcile would add post-response
  work with its own duration and concurrency lifecycle on top. The correct reading is that this route
  already has an unbounded per-request loop, which **raises the urgency of bounding its input**
  (**AUDITFIX-17**) before adding another per-item stage — not that the allocation finding is weakened.
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

And round 3 found the habit twice more, in text I had written *while correcting the habit*: I
classified `lib/actions/handlers.ts` as "runs in the scheduler's process" without opening
`app/api/v1/actions/route.ts`, and excluded `scripts/` because seeding "is followed by a drain" when
only the Docker bootstrap drains. It also caught the design being **unsatisfiable against the real
tree** — a single `RECONCILES` class requiring `after()`, against two meeting writers that reconcile
inline on purpose and one that must.

The common shape is not carelessness about code; it is **inherited or invented prose treated as
evidence.** The one artefact that reliably broke the chain was going back to the source — production
for numbers, `git grep` for history, the file itself for a rationale — which is what
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

⚠️ **Labelled precisely, because round 3 showed "reachability" still overstates it.** This measures
*"an active include into a project that has SOME grant"*. The oracle additionally intersects grants
with the principal's own `group_members` edges (`lib/access/oracle.ts:65,74,98`), and this timestamps
at `m.created_at` rather than the later of membership and grant — so an item included into a project
granted only to an empty group would read as reachable. On this deployment both system projects are
granted to `everyone` and all nine members are in it, so the two coincide; the label is narrowed
rather than the claim re-argued.

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

## 11. Round 3 — BLOCKED, and the design was unsatisfiable against the real tree

**3 BLOCKER, 5 HIGH, 3 MEDIUM**, aimed at the narrowing — because a slice cut down under review
pressure is where over-correction hides, and this one had it.

| # | finding | outcome |
|---|---|---|
| **B1** | the guard would not have failed when the codebases route was introduced, and will not catch that shape again — the route calls `ingestCodebaseScan`, not `ingestItem`; a new route on an existing wrapper is invisible to it | **CONFIRMED.** My "would have failed #530" was true but implied protection it does not give. §2a now states the accurate claim (it would have failed `a32b6923` and #530) **and** the limit; §3e documents entry surfaces as explicitly unenforced, with **AUDITFIX-18** named |
| **B2** | the `RECONCILES` rule cannot pass against the real inventory — both meeting writers reconcile **inline, deliberately**, and `merge.ts:287` must (it aborts the merge if the reconcile fails, before re-pointing the survivor) | **CONFIRMED, and fatal to the draft.** AC3 could never have passed. Three obligation classes now, each with the check that is actually true for it (§3d) |
| **B3** | a literal-specifier walk misses `import { ingestItem } from "./ingest/index"`, and AC3's set-equality then **certifies** the incomplete set | **CONFIRMED — and the escape is already in the tree**: `scripts/seed-demo.ts:13` imports relatively. Canonical module resolution (§3b); controls 4 and 5 pin it |
| **H4** | four of nine negative controls were incidental — control 5 had no call at all and should PASS | **CONFIRMED.** Every fixture is now self-contained with a canonical import and a real call, asserts its exact diagnostic, and four **positive twins** are added so a guard that always fails cannot satisfy the table (§5a) |
| **H5** | the table listed seven files by adding the codebases route "via commits-to-items", which a direct-call walk cannot discover — AC3 would fail on its own stale entry | **CONFIRMED.** The route moved to §3e; the inventory is direct callers only |
| **H6** | excluding `scripts/` is not justified — only Docker bootstrap drains; `npm run dev:seed` does not | **CONFIRMED. Exclusion withdrawn**, `scripts/` is in the walk (§3d). A rule claiming every writer while excluding a supported writer command is the quiet narrowing this document exists to stop |
| **H7** | the `lib/actions/handlers.ts` rationale is factually wrong — reached from `POST /api/v1/actions`, not the scheduler | **CONFIRMED.** Reclassified as an HTTP/admin writer outside the scheduler chain |
| **H8** | the latency clause is prose; nothing validates a rationale or a claimed latency | **CONFIRMED.** §2 now states exactly what the build enforces and marks the latency column review-only |
| **M9** | §8 still overstates "reachability" — the oracle also intersects with the principal's own group edges, and the timestamp ignores a later grant | **CONFIRMED.** Label narrowed to "an active include into a project that has some grant"; why it coincides on this deployment is stated |
| **M10** | "constant-factor increase" does not partially refute the allocation finding | **CONFIRMED. Withdrawn** — it raises the urgency of bounding the input (AUDITFIX-17), nothing more |
| **M11** | AC7 (pinning the corrected comment) is ceremony — forbidding one phrase cannot make a future comment accurate | **CONFIRMED. Dropped.** The comment fix stays as cleanup with no guard attached |

**Nothing is built. No code exists for any of the four designs.**
