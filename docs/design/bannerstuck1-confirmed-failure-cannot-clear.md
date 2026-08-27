# A confirmed failure that nothing can clear — BANNERSTUCK-1

**Status:** spec, round 4 — SIX review rounds folded (Codex BLOCKED ×3, Fable CLEAR-WITH-CONDITIONS ×3).
Round 3 made the design SMALLER: two of the states I had built criteria around cannot occur. No code written.

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

> **A confirmed failure is evidence only while the leg is still being exercised. A pass that OBSERVED
> THE WHOLE ELIGIBLE SET and found no work demanded has produced contrary evidence and may clear the
> alarm. A pass that was gated, abstained, or saw only PART of the set must do neither — and must never
> be able to hide a failure that happened while it ran.**

## 2. The design

### 2a. Which outcomes may clear — derived from the code, not from the labels

| site | outcome | clears? |
|---|---|---|
| `:147` | `cooldown` | ❌ the pass never ran |
| `:151` | `no-llm` | ❌ unconfigured — a different state, and its own signal |
| `:195` | `no-candidates` | ✅ the task list was read; nothing to offer |
| `:206` | `nothing-to-score` | ✅ **only if the item scan did not saturate** |
| `:237` | `nothing-to-score` | ✅ **only if unsaturated AND no doc was dropped for an unresolvable owner** |
| `:270` | `unchanged` | ✅ **only if the item scan did not saturate** |

**The saturation rule covers THREE sites, not one.** The item read is `.limit(ITEM_SCAN)` = 500,
ordered **`work_at desc`** (`doc-task-infer-run.ts:184` — round 3 said `updated_at`, which is the
*tasks* read at `:164`; the sentence was wrong). `:206`, `:237` and `:270` are all derived by JS
filters over that one truncated page, so with ≥500 items in the window each of them is a claim about
*the newest 500 only* — item #501 can be an unscored design doc. §1's rule therefore forces all three
to abstain when `items.length >= ITEM_SCAN`. *(`visibleItems(q,"team")` is a passthrough, so nothing
post-drops rows and the count is honest. Exactly 500 abstains too — conservative, and correct.)*

**The `:237` abstain bucket is NOT what round 3 said.** Both reviewers independently derived, and I
verified, that *"a human-owned doc with no attribution"* **cannot occur**:

- the wide scan already excludes ownerless items in SQL — `.not("member_id","is",null)` (`:177`);
- `creditedPrimaryId` returns null **only** when `currentMemberId` is null, and that is nulled only
  when `isHuman()` is false (`contributor-credit.ts:50-61,190`);
- a genuine oracle failure **throws** in `strict` mode (`contributor-credit.ts:126-128`) and lands in
  the catch at `:408` as an `ok=false` run — it never appears as a `:237` drop.

So the four real buckets are:

| dropped because | legitimate? |
|---|---|
| already deterministically linked | ✅ |
| `access === "external"` | ✅ |
| owner is a **connector** (excluded from credit by design) | ✅ |
| owner resolves to **no member row for this team** (dangling / cross-team id) | ❌ **abstain** |

Only the last is a reason to withhold, and telling it apart needs `members.is_connector` for the raw
`member_id` — which neither the oracle's return nor `teamRoster` exposes (`:545`, no `is_connector`,
and `status='active'`-filtered). So the run adds a plain `is_connector` read keyed off `docRows`'
member ids, populating a new `InferDoc.ownerKind`. `scoreableDocs` has exactly **one** production
caller (`:236`), so returning drop counts leaks no policy.

⚠️ **The justification remains narrow:** an idle pass does not prove the provider recovered
(`lib/llm/complete.ts:212` argues exactly that in-repo). It proves only that **no output is currently
demanded, so a historical failure must not drive a present-tense alarm.**

### 2b. Correctness is ORDERING; the condition is only write-avoidance

The clearing row is written with **`finishedAt = the pass's own startedAt`** (`:140`;
`recordIngestRun` already accepts `finishedAt`, `runs.ts:31`). `STREAK_SQL` orders
`finished_at desc, id desc` (`pipeline-health.ts:351`), so **any row recorded during the pass sorts
newer than the clearing row** — a concurrent failure cannot be masked by commit order, snapshot
visibility, or an `INSERT … WHERE NOT EXISTS` that round 3 proved races under `READ COMMITTED`.

⚠️ **Two residuals, stated rather than claimed away.** Round 3 wrote "impossible … whatever the clock
skew", which is an overclaim: ordering compares timestamp VALUES, so masking needs
`t_B − t_A < skew_A − skew_B`. (a) a failure finishing in the same millisecond loses the `id desc` tie;
(b) two processes with skewed clocks. Bounded in practice: the scheduler runs **inside the web
process** (`instrumentation.ts:57`) and the timeline rebuild runs there too, so the live deployment has
one clock; a deploy-overlap twin is NTP-scale. And a masked failure is **self-correcting** — `failing`
needs a streak of two, so the next real failure re-confirms.

**The write happens only when the leg's newest verdict is a FAILURE** — event-driven, not throttled.
This is round 0's condition returning, but its job has changed completely: correctness now comes from
the ordering above, and the condition exists to avoid perpetual ledger traffic.

⚠️ **That deletes an entire layer.** Round 3 had the clearing row resetting the paid-run cooldown, a
freshness regression that would make Monday morning's doc wait 12h, "fixed" by a two-clock scheme with
a `meta.skipped` filter on `lastRun`'s `limit(1)` read. **All of it is unnecessary:** in the steady
state (newest verdict already `ok=true`) nothing is written, so the cooldown is never touched, no new
duration constant is needed, and ~730 rows/team/year of append-only history are never created.

The row carries **`meta.health_clear = true`** — a dedicated marker, not the overloaded `meta.skipped`.

⚠️ **Two honest labels:** `duration_ms` is **0** by construction (`runs.ts:77`), and the row's
`finished_at` is the pass's START. Nothing computes on either (`listRecentIngestRuns` is
order-tolerant; `doc_task_infer`'s staleness threshold is `null`), but the row is synthetic health
evidence and its comment must say so rather than let a reader take it for a timed pass.

### 2c. The map is corrected — the whole block

`pipeline-health.ts:154-168` carries **four** claims that this change falsifies, not the one round 0
found. The `null`-threshold conclusion stays right; its argument is rewritten.

### 2d. Fix `doc_task_infer` alone

`pret3_sweep` is **already fixed** (§0f). `linear_inbound` is a **confirmed twin**
(`scheduler.ts:159-160`) — not fixed here. `dense` has a narrower hole (records only on
`failed>0 || indexed>0`, so a *purged* backlog latches). `arcs`/`graph_project` self-clear.
`doc_task_infer` is unique in that **healing removes the reason to record**.

⚠️ **Residual, named:** a team that removes its keys stays loud forever (`no-llm` never clears).

## 3. Scope

**In:** `lib/dashboard/doc-task-infer-run.ts` · `lib/dashboard/doc-task-infer.ts` (drop reasons +
`ownerKind`) · the corrected block in `lib/ingest/pipeline-health.ts` · guards · data-mechanics tests.

**Out:** any new duration constant (none is needed — §2b); `STALE_MS_BY_SOURCE`;
`FAILURES_TO_CONFIRM`; `linear_inbound`/`dense`/the `no-llm` residual; **paging the `ITEM_SCAN` read**
— saturation abstains instead, which is correct for THIS slice's no-false-clear property, though a
busy team then stays latched until it drops under 500 (named, not fixed).

## 4. Acceptance

⚠️ **Fixture facts, each of which blocks a criterion if missed:** seeded failure rows are non-skipped
and therefore **arm the cooldown** — they must be aged past `COOLDOWN_MS` or the pass returns
`cooldown` before any clearing branch. AC1's `:237`/`:270` cases must **seed tasks**, or `:195`
`no-candidates` clears first and the fixture trips two criteria. AC4 must **age its produced first
failure** (`COOLDOWN_MS` has a 1-hour floor, `Math.max(1,…)` at `:88`), never seed the second.

- **AC1 — every clearing outcome clears (dm):** once per case — `no-candidates`, unsaturated `:206`,
  unsaturated `:237` with only legitimate drops, unsaturated `:270` — assert via **`getPipelineHealth`**
  that the leg leaves `failing`, and that the row has `ok=true`, `meta.health_clear`, and
  `finished_at === passStartedAt`.
- **AC2 / AC2b — `cooldown` and `no-llm` do not clear (dm):** exact returned outcome, row count unchanged.
- **AC2c — a doc dropped for an UNRESOLVABLE owner does not clear (dm):** a `member_id` that resolves
  to no member row for this team. *Round 3 specified this as "a human-owned doc with no attribution",
  a state the code cannot produce — the criterion was unbuildable and its mutation aimed at nothing.*
- **AC2d — a CONNECTOR-owned window DOES clear (dm):** the inverse. *Without it, the conservative
  reading ships and the leg never clears for a connector-fed team.*
- **AC2e — a SATURATED scan does not clear, at ALL THREE sites (dm):** `:206`, `:237` and `:270` each
  abstain with ≥`ITEM_SCAN` items. *Round 3 pinned only `:206` while `:237`/`:270` read the same
  truncated page.*
- **AC3 — the steady state writes nothing (dm):** newest verdict `ok=true` → an idle pass writes
  **zero** rows. *This is now the whole cooldown story: nothing is written, so nothing is deferred.*
- **AC4 — a real failure is still loud (dm):** two failures produced by RUNNING the pass, ageing the
  first between runs; `confirmed`, in `failing`, `failingSince` = the oldest.
- **AC5 — a concurrent failure can never be masked (dm, deterministic):** via the exported seam
  `recordClearingRun(db, teamId, passStartedAt, reason)` — seed the streak, record a produced failure
  NOW, call the seam with `passStartedAt` five minutes past. The assertion is that **the failure is
  still the NEWEST row** (`leg.ok === false`) and the leg is `unconfirmed`, and that the very next
  failure re-confirms it.

  ⚠️ **Round 4 wrote this as "still `failing`", which is wrong, and the test caught it.** The
  backdated row lands BETWEEN the old streak and the new failure, so the newest failure's streak is 1
  and `FAILURES_TO_CONFIRM = 2` makes it `unconfirmed` — quiet by the SAME policy that stops one blip
  painting the banner. Round 2's Codex review said exactly this and I folded the words but not the
  criterion. **The property backdating actually guarantees is narrower: the clearing row can never sit
  ON TOP of a concurrent failure and erase it.** The alarm is deferred by one run, not lost — and the
  positive control below proves the mechanism is load-bearing.
- **AC5-control — WITHOUT backdating the same interleaving DOES mask (dm):** the identical fixture with
  the row stamped `now` instead of the pass start leaves the leg `ok` and not failing. *A negative
  control on the mechanism itself: without it, AC5 would pass on a build where backdating did nothing.*
- **AC5b — the call site passes its OWN `startedAt` (unit, CLOCK-ADVANCING):** the fake clock must
  ADVANCE between `:140` and the write, or `Date.now()` at write time equals the captured value and
  mutation 10 survives a naive spy. *Green-by-construction otherwise — the class AC5 exists to avoid.*
- **AC6 — a thrown read never becomes a clearing row (unit).**
- **AC7 — no time-based escalation (dm, behavioural):** `getPipelineHealth` classifies a failure at 2
  days and at 60 days identically with no intervening run.
- **AC8 — the whole `:154-168` block is true (guard, unit).**

| # | mutation | must redden |
|---|---|---|
| 1 | the clearing row is never written | AC1 |
| 2 | only one clearing outcome is wired | AC1 |
| 3 | `cooldown` clears | AC2 |
| 4 | the write is wired above `:151` | AC2b |
| 5 | an unresolvable owner clears | **AC2c** |
| 6 | `:237` never clears (round 3's over-broad rule) | **AC2d** |
| 7 | the saturation abstain is dropped at `:206` | AC2e |
| 8 | the saturation abstain is dropped at `:237`/`:270` | **AC2e** |
| 9 | `finishedAt` is `Date.now()` instead of `passStartedAt` | **AC5** |
| 10 | the call site passes `Date.now()` rather than its own `startedAt` | **AC5b** |
| 11 | the row is written even when the newest verdict is `ok` | **AC3** |
| 12 | the clearing row is written with `ok=false` | AC1 |
| 13 | a thrown read becomes a clearing row | AC6 |
| 14 | `FAILURES_TO_CONFIRM` raised so nothing confirms | AC4 |
| 15 | `failingSince` reports the newest failure | AC4 |
| 16 | an inline elapsed-time escalation in `getPipelineHealth` | AC7 |
| 17 | restore any one of the four false claims in the block | AC8 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| A concurrent failure is masked | **the loudest alarm goes quiet on a broken leg** | §2b backdating (ordering, not guarding); AC5 + mutations 9/10; residuals stated and self-correcting |
| Clearing on a partial view of the window | clears while work is pending | saturation abstain at all three sites; AC2e + mutations 7/8 |
| An unresolvable owner silences the alarm | a data-integrity fault reads as health | §2a's drop split; AC2c + mutation 5 |
| The fix makes the leg NEVER clear | the bug inverted — round 3 would have shipped it | AC2d + mutation 6 |
| The alarm is silenced by a leg that never ran | worse than the bug | AC2/AC2b + mutations 3/4 |
| A later tweak reintroduces a grace period | the fix BANNERFLAP-1 §3a proved wrong | AC7 behavioural, mutation 16 |

## 6. What would falsify this

A **successful** `doc_task_infer` run before this ships would clear the banner on its own and make the
incident look self-healing. It would not falsify the defect. **Re-measured 2026-08-28: the streak is
still 4, with no new row in a further ~24h** — the leg has now been silent-but-polled for ~2 days, and
the falsifier has not fired.

**Nothing is built. No code exists for this slice.**
