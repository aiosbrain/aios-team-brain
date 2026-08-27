# A confirmed failure that nothing can clear — BANNERSTUCK-1

**Status:** spec, round 3 — four review rounds folded (Codex BLOCKED ×2, Fable CLEAR-WITH-CONDITIONS ×2). No code written.

**Build with:** opus / high — it changes when the loudest alarm in the product speaks, and the
failure mode in BOTH directions is a lie: an alarm that will not stop, or one that goes quiet on a
real break.

**Deps:** none — it touches neither schema nor any in-flight slice. (DOCKERPROD-2 / PR #664 is
unrelated: deploy plumbing, no overlap.)

**Related, and READ FIRST:** `docs/design/pipeline-banner-failure-confirmation.md` (BANNERFLAP-1 —
this spec extends its rule rather than reversing it), `docs/design/staleness-threshold-fit.md`
(BANNERFLAP-2 — why re-fitting a constant is the wrong instinct here).

---

## What is wrong

Chetan, 2026-08-27, against the live Pulse page: *"i'm still seeing errors at the top of the screen."*

> 🔴 **1 ingestion leg is broken — the brain isn't getting fresh data**
> `doc_task_infer` — failing since 2d ago: OpenRouter is out of credit…

**The cause healed 26 hours before that screenshot.** The banner cannot say so, and no future event
can make it say so.

## 0. Terrain, measured on prod before designing

### 0a. The leg's actual history

`doc_task_infer`, `trigger='scheduler'`:

| finished_at (UTC) | ok |
|---|---|
| 2026-08-26 13:12 | ❌ |
| 2026-08-26 00:49 | ❌ |
| 2026-08-25 12:24 | ❌ |
| 2026-08-25 00:11 | ❌ |
| 2026-08-24 11:42 | ✅ ← last success |

Streak = **4**, and `FAILURES_TO_CONFIRM = 2` (`lib/ingest/failure-streak.ts:37`) → `confirmed` →
in the `failing` set → the loud banner. `failingSince` = 2026-08-25 00:11, which is what renders as
*"failing since 2d ago"*.

### 0b. The cause is gone — three independent readings

| reading | result |
|---|---|
| newest `http_402` **anywhere** in `llm_failures` | **2026-08-26 13:12** — the same instant as the last failed run, 26h before the screenshot |
| all `llm_failures` in the last 12h | **2 rows**: one `timeout`, one `no_usage`. **Zero** credit refusals |
| `llm_usage` last 6h | `timeline-summary` **22 successes** |
| scheduler liveness | `slack`/`linear` recorded **<1 min** ago; `github`/`meeting_notes`/`access_bootstrap` ~30 min |

The account was topped up, the provider is answering, and the poller is ticking.

### 0c. Why nothing can clear it — read from the code, not assumed

The streak breaks **only** when a row with `ok=true` is recorded. Five of `doc_task_infer`'s eight
outcomes return *before* `record()`:

| outcome | site |
|---|---|
| `cooldown` (12h) | `lib/dashboard/doc-task-infer-run.ts:147` |
| `no-llm` | `:151` |
| `nothing-to-score` | `:237` |
| `unchanged` | `:270` |
| `no-candidates` | (same early-return family) |

Only the 7-day window's *scoreable* docs can produce work, and prod's last 7 days contain only
`artifact` and `deliverable` items. So a **healthy leg, polled every tick, writes nothing** — and the
Aug 26 failure stays the newest row indefinitely.

**Staleness cannot rescue it, by explicit prior decision.** `STALE_MS_BY_SOURCE` sets
`doc_task_infer: null` (`lib/ingest/pipeline-health.ts:168`) with a written argument that *no finite
age threshold is correct for this class*. That decision is right and this spec does not touch it.

### 0d. The false premise is a comment in the code

`pipeline-health.ts`, on `doc_task_infer`:

> *"Real failures still surface: … since the cooldown counts failed runs too, **a persistent failure
> keeps re-recording and stays the newest row.**"*

True only while the failure **persists**. When the cause clears and there is no new work, nothing
re-records — and a healed failure is byte-identical to a live one. That sentence is the whole bug,
and it must be corrected in the same change.

### 0e. What the prior design DID decide, and why this is not a reversal

⚠️ This is the part that would make a careless fix wrong. BANNERFLAP-1 §3a already contemplated
never-superseded failures and **accepted a cost**:

> *"a `null`-threshold leg that **fails once** and is then never exercised again **stays quiet** in the
> banner indefinitely … the standing rule in this codebase is that **ignorance must not accuse**."*

That accepted cost is in the **quiet** direction — a streak of **1**, deliberately `unconfirmed`.
**This ticket is the opposite direction**: a streak of **≥2** that stays **LOUD** indefinitely. §3a
never considered it, and its own governing principle — *ignorance must not accuse* — argues for
fixing it: once the leg stops being exercised, the streak is no longer evidence of anything, yet it
keeps accusing at maximum volume.

### 0f. THE PRECEDENT THAT SETTLES IT — this repo has already fixed this exact defect once

`lib/ingest/scheduler.ts:57`, on `pret3_sweep`, describes this ticket without knowing it:

> *"Exactly one success row, ever — and it is what lets a CONFIRMED failure streak clear. Without it:
> two failed marker-insert ticks reach `confirmed` and go loud, a later success writes nothing, and
> the consumed marker forecloses every future row — so **the loud banner latches red permanently on
> every team, which no staleness threshold can undo** (`failing` includes `confirmed` regardless of
> age)."*

Same mechanism, same conclusion, and the remedy shipped: **write the success row that lets the streak
clear.** So this slice applies an established in-repo policy to the leg that still needs it, rather
than inventing one against a prior decision. ⚠️ *It also corrects §2d: `pret3_sweep` is NOT one of the
unfixed legs — my first draft listed it, and that was wrong.*

*(Round 0 argued this under §3a's slogan "ignorance must not accuse". Fable was right that the slogan
is stretched — the banner is not ignorant, it has four real rows. The honest frame is **standing
evidence must be defeasible by contrary evidence**, and §0f is the precedent for that.)*

⚠️ §3a also **rejected time-based escalation** outright ("no safe value exists"; it would "smuggle
back in, through a different constant, the exact thing those `null`s were written to prevent").
**So the fix may not be an age-out, a grace period, or any new duration constant.** That constraint
is inherited, not negotiable here.

## 1. The rule

> **A confirmed failure is evidence only while the leg is still being exercised. A pass that
> OBSERVED THE WHOLE ELIGIBLE SET and found no work demanded has produced contrary evidence, and that
> evidence must be able to clear the alarm — while a pass that was gated, abstained, or saw only part
> of the set must neither clear it nor be masked by one.**

## 2. The design

### 2a. Only a pass that observed the WHOLE eligible set and found no work may clear

The outcome LABELS are not the rule — two of them cover both a healthy and an unhealthy state:

| site | outcome | clears? | why |
|---|---|---|---|
| `:147` | `cooldown` | ❌ | the pass never ran |
| `:151` | `no-llm` | ❌ | unconfigured — a different state, and its own signal |
| `:195` | `no-candidates` | ✅ | the task list was read; there is nothing to offer |
| `:206` | `nothing-to-score` | ✅ **only if the scan did not saturate** | see below |
| `:237` | `nothing-to-score` | ✅ **only if every drop was a legitimate one** | see below |
| `:270` | `unchanged` | ✅ | every eligible doc is already answered |

**`:206` — the bounded scan.** The item read is `.limit(ITEM_SCAN)` = **500**, ordered `updated_at desc`
(`doc-task-infer-run.ts:185`). So `docRows` empty means *"nothing scoreable in the newest 500"*, not
*"nothing in the 7-day window"*: 500 newer Slack rows can hide an older unscored design document, and
clearing there would silence the alarm while work is genuinely pending. **So `:206` may clear only
when the scan returned fewer than `ITEM_SCAN` rows** — i.e. the window was observed in full. When it
saturates, the pass abstains. *(Prod today: 152 items in 7 days, so this is not the live path — but a
busy team crosses 500 and the fix must not be wrong for them.)*

⚠️ *A residual, stated: `:206`'s pure filters can still be emptied by a data-shaped regression
(`frontmatter.source` naming, `classifyWork`, `work_at_from_source` stamping). Pre-change that made
the leg silently invisible; post-change it would actively clear. The emptiness does derive from rows
the pass actually READ — unlike `:237` — which is why the line is drawn here, but the direction of the
cost changed and that is worth knowing.*

**`:237` — split by DROP REASON, not wholesale.** `scoreableDocs` (`doc-task-infer.ts:97`) drops on
**three** predicates, and round 2 treated all of them as the oracle abstaining:

```ts
!d.hasDeterministicLink && d.access !== "external" && !!d.memberId
```

| dropped because | legitimate no-work? |
|---|---|
| already has a deterministic issue-key link | ✅ yes — the link exists, nothing to infer |
| `access === "external"` | ✅ yes — deliberately never scored |
| no `memberId`, and the item is **connector-owned** | ✅ yes — connectors are excluded from credit BY DESIGN (`contributor-credit.ts`), so there is no person to reason about |
| no `memberId` for a **human-owned** item | ❌ **NO** — this is `resolveItemCreditIds({strict:true})` abstaining, and the code says so: *"if the oracle can't answer, the right move is to spend nothing this tick"* |

So `scoreableDocs` must report drop counts by reason, and the pass clears only when the
unattributable-human count is **zero**. Round 2 would have blocked clearing for the three legitimate
cases — making the leg never clear for a team whose docs are all deterministically linked.

⚠️ **The justification is narrow, and narrower than round 0 claimed.** An idle pass does **not** prove
the provider recovered — `lib/llm/complete.ts:212` argues exactly this in-repo (*"`ok: true` would
claim a model that was never asked"*). It proves only: **there is no output currently demanded, so a
historical provider failure must not drive a present-tense alarm.**

### 2b. The clearing row is BACKDATED — masking becomes impossible by ordering, not improbable by guarding

Rounds 0–2 tried two mechanisms and both were wrong:

- **Round 0** wrote the row only when the newest row was a failure — a check-then-insert race.
- **Round 2** added a "no row since this pass started" guard. **Also insufficient**: under PostgreSQL
  `READ COMMITTED` an `INSERT … WHERE NOT EXISTS` runs its subquery against the statement snapshot, so
  a concurrent `ok=false` that has not yet committed is invisible, both rows land, and the clearing
  row is still newer. `ingest_runs` has no unique constraint to conflict on, and an advisory lock only
  works if **every** writer takes it — the failure path is a plain `recordIngestRun` (`runs.ts:59`).

**The fix is ordering, not locking.** The clearing row is written with
**`finishedAt = the pass's own startedAt`** (`doc-task-infer-run.ts:140`). `recordIngestRun` already
accepts `finishedAt` (`runs.ts:31`), so this needs no new plumbing. Because `STREAK_SQL` orders
`finished_at desc, id desc` (`pipeline-health.ts:351`), **any row recorded during the pass is strictly
newer than the clearing row** — a concurrent failure can never be masked, whatever the commit order,
snapshot or clock skew.

It also interacts correctly with the cooldown: `lastRun` orders on `finished_at` alone
(`doc-task-infer-run.ts:457`), so a backdated clearing row older than a concurrent failure leaves the
cooldown counting from the failure, which is the right clock.

⚠️ **Residual, stated:** a failure finishing in the same millisecond as the pass's start loses the
`id desc` tie to the clearing row. ~1ms; accepted.

**The existence check stays**, demoted to what it honestly is — a write-avoidance optimisation, not a
correctness guarantee — and its comparator is **`>=`** (a `>` misses the same-millisecond row).

### 2b-bis. TWO CLOCKS — the clearing row must not defer real scoring

⚠️ Round 2 said "clearing takes up to 12h" and **understated the cost**. The real regression is on the
other side: today, once past the cooldown, an idle pass records nothing, so the clock never resets and
the first tick after new work arrives scores it within ≤30 min. If a clearing row became `lastRun`,
every quiet weekend pass would reset the clock and **Monday morning's design doc would wait up to 12
hours** for linking that costs one tick today. That is a new steady-state freshness regression, and it
contradicts the existing comment that the cooldown is a minimum gap between **paid** runs
(`doc-task-infer-run.ts:143`) — a clearing pass is unpaid.

So there are two clocks:

- **the paid-run cooldown** (`:147`) ignores rows carrying `meta.skipped` — unchanged behaviour;
- **the clearing write** throttles on the age of the last *clearing* row.

Same ~2 rows/team/day, and **zero added scoring latency**.

### 2c. The map is corrected — the whole block, not one sentence

`pipeline-health.ts:154-168` will have **four** false claims after this change, not the one round 0
found: that five outcomes write no row (three now do), and that "a perfectly healthy leg polled every
30 minutes still writes nothing for days". The `null`-threshold **conclusion** stays correct — a
`no-llm` team still writes nothing, so no finite age is right — but its argument must be rewritten.

### 2d. Fix `doc_task_infer` alone — and record why, so the next one is recognised

- **`pret3_sweep` is ALREADY FIXED** (§0f) — round 0 listed it, wrongly.
- **`linear_inbound` is a CONFIRMED twin**, not merely unverified: a quiet healthy pass returns before
  `recordIngestRun` (`scheduler.ts:159-160`), so heal-with-nothing-to-apply latches. Not fixed here.
- **`dense` has a narrower hole**: it records only on `failed > 0 || indexed > 0`
  (`scheduler.ts:106-128`), so if the failing backlog is PURGED during an outage rather than retried,
  the healing run indexes 0, records nothing, and the streak latches.
- `arcs` and `graph_project` self-clear: their failure leaves pending work that survives the heal.

`doc_task_infer` is unique in that **healing removes the reason to record**.

⚠️ **Two residual BANNERSTUCKs, named not fixed:** a team that removes its keys stays loud forever
(`no-llm` never clears); and a team whose entire 7-day scoreable window is **connector-attributed**
sits at `:237` legitimately forever. Both are the same class.

## 3. Scope

**In:** `lib/dashboard/doc-task-infer-run.ts` · `lib/dashboard/doc-task-infer.ts` (drop reasons) ·
the corrected block in `lib/ingest/pipeline-health.ts` · guards · data-mechanics tests ·
`docs/ARCHITECTURE.md` if the ingestion-health prose is affected.

**Out:**
- **Any new duration constant, grace period or age-out** — rejected by BANNERFLAP-1 §3a (§0e).
- `STALE_MS_BY_SOURCE`, `FAILURES_TO_CONFIRM` — unchanged.
- `linear_inbound`, `dense`, the `no-llm` and connector residuals — named in §2d, separate slices.
- Paging the `ITEM_SCAN` read — §2a abstains on saturation instead, which is correct and smaller.

## 4. Acceptance

⚠️ **Fixture requirements, because three of these cannot pass without them:** AC1–AC3 must seed
answering keys, or the pass returns `no-llm` before any clearing branch. **AC4 must AGE its first
produced failure** (`update ingest_runs set finished_at = …`) between the two runs — `COOLDOWN_MS` has
a **1-hour floor** (`Math.max(1, …)`, `:88`), so no env value lets a second run reach the model, and
seeding the second failure instead is exactly what AC4 forbids.

- **AC1 — every clearing outcome clears (data-mechanics):** seed a confirmed streak, then once per
  clearing case — `no-candidates`, `:206` unsaturated, `:237` with only legitimate drops, `unchanged` —
  assert via **`getPipelineHealth`** that the leg leaves `failing`, and assert the inserted row has
  `ok=true`, `meta.skipped`, and `finished_at === passStartedAt`.
- **AC2 — `cooldown` does not clear (dm).** **AC2b — `no-llm` does not clear (dm)** *(one gate above
  the clearing branches — a write wired one return too high passes everything else)*. **AC2c — a
  HUMAN-owned unattributable doc at `:237` does not clear (dm)**, while **AC2d — an all-connector-owned
  window at `:237` DOES clear (dm)**. **AC2e — a SATURATED `:206` scan does not clear (dm).** *Each
  asserts the exact returned outcome and that the row count is unchanged.*
- **AC3 — the steady state (dm):** newest row `ok=true` and older than the cooldown; the pass returns
  its idle outcome and writes **exactly** the row the design permits — not "at most", which permits
  zero and would let a no-op implementation pass.
- **AC4 — a real failure is still loud (dm):** two failures **produced by running the pass** (stubbed
  model returns null → `ok=false` at `:351`), ageing the first between runs; leg `confirmed`, in
  `failing`, `failingSince` = the OLDEST failure.
- **AC5 — a concurrent failure can never be masked (dm, deterministic):** the clearing write is an
  exported seam `recordClearingRun(db, teamId, passStartedAt, reason)`. Seed the streak, record a
  produced failure NOW, then call the seam with `passStartedAt` five minutes in the past: the leg is
  **still `failing`**, and the clearing row's `finished_at` is strictly older than the failure's.
  *Round 2's version was VACUOUS: an idle pass has no awaitable seam between its reads and its write,
  so a `Promise.all` test ends `failing` even with the guard deleted — the mutation would have
  survived and the criterion was green by construction.*
- **AC5b — the call site passes its OWN `startedAt` (guard, unit):** the pass must hand
  `recordClearingRun` the `startedAt` captured at `:140`, not `Date.now()` at write time. *That
  mutation empties the ordering window and the seam test alone cannot see it.*
- **AC6 — a thrown read never becomes a clearing row (UNIT):** with each of the task/item/credit/roster
  reads throwing, the orchestration records `ok=false` or nothing, never a clearing row. *Unit, not
  data-mechanics: real Postgres has no fault injection, and this is orchestration shape.*
- **AC7 — no time-based escalation (dm, behavioural):** `getPipelineHealth` over real rows classifies
  a failure at 2 days and at 60 days **identically** with no intervening run. *Named surface on
  purpose: `classifyFailure`/`foldStreak` are pure over the streak and never see a clock, so a unit
  test there is green under any escalation added where the clock actually lives (`:463-494`).*
- **AC8 — the whole comment block is true (guard, unit):** `pipeline-health.ts:154-168` no longer
  claims five outcomes write no row, nor that a healthy leg writes nothing for days, and states the
  narrower truth. *Round 2 scoped this to one sentence, satisfiable while three other claims lie.*

| # | mutation | must redden |
|---|---|---|
| 1 | the clearing row is never written | AC1 |
| 2 | only one clearing outcome is wired; the others stay stuck | AC1 |
| 3 | `cooldown` also clears | AC2 |
| 4 | the write is wired above `:151`, so `no-llm` clears | AC2b |
| 5 | `:237` clears regardless of drop reason | **AC2c** |
| 6 | `:237` never clears (round-2's over-broad rule) | **AC2d** |
| 7 | `:206` clears even when the scan saturated | **AC2e** |
| 8 | the clearing row is written with `ok=false` | AC1 |
| 9 | **`finishedAt` is `Date.now()` instead of `passStartedAt`** | **AC5** |
| 10 | the call site passes `Date.now()` rather than its own `startedAt` | **AC5b** |
| 11 | the paid-run cooldown counts clearing rows (one clock) | AC3 / freshness |
| 12 | a thrown read is swallowed into a clearing row | AC6 |
| 13 | `FAILURES_TO_CONFIRM` raised so nothing confirms | AC4 |
| 14 | `failingSince` reports the newest failure | AC4 |
| 15 | an inline elapsed-time escalation in `getPipelineHealth` (real shape) | **AC7** |
| 16 | restore any one of the four false claims in the block | AC8 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| A concurrent real failure is masked by a clearing row | **the loudest alarm goes quiet on a broken leg** | §2b backdating makes it impossible by ordering; AC5 + mutations 9/10 |
| A broken attribution oracle silences the alarm | same label, opposite meaning | §2a's drop-reason split; AC2c + mutation 5 |
| The fix makes the leg NEVER clear | the bug, inverted — and round 2 would have shipped it | AC2d + mutation 6 |
| Clearing on a partial view of the window | clears while work is pending | §2a's saturation check; AC2e + mutation 7 |
| The clearing row defers real scoring by up to 12h | a new freshness regression traded for a banner fix | §2b-bis's two clocks; mutation 11 |
| The alarm is silenced by a leg that never ran | worse than the bug | AC2/AC2b + mutations 3/4 |
| A later tweak reintroduces a grace period | the fix §3a proved wrong | AC7 is behavioural, mutation 15 |

## 6. What would falsify this

If `doc_task_infer` records a **successful** run before this ships, the banner clears on its own and
the incident looks self-healing. **That would not falsify the defect** — the mechanism in §0c is
unchanged and the next healed-but-idle failure reproduces it. Re-take §0a's streak, not the banner's
colour.

**Nothing is built. No code exists for this slice.**
