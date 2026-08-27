# A confirmed failure that nothing can clear — BANNERSTUCK-1

**Status:** spec, round 1 — both spec reviews folded (Codex BLOCKED, Fable CLEAR-WITH-CONDITIONS). No code written.

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

> **A confirmed failure is evidence only while the leg is still being exercised. A leg that has since
> completed a clean pass with nothing to do has produced positive evidence of health, and that
> evidence must be able to clear the alarm — while a leg that merely has not run must neither clear
> it nor keep shouting on the strength of it.**

## 2. The design

### 2a. Only a pass that DEMONSTRABLY completed a clean evaluation may clear

⚠️ **Round 0 got this wrong in a way that could have silenced a real alarm.** It said "the three
outcomes `nothing-to-score` / `unchanged` / `no-candidates`" — but `nothing-to-score` is **two
different code paths with opposite meanings**, and the label hides it:

| site | condition | meaning | clears? |
|---|---|---|---|
| `:206` | `docRows` empty — no scoreable-source work docs in the 7-day window | **genuine idle**: the leg read the corpus successfully and there is nothing to do | ✅ |
| `:237` | `allScoreable` empty **after** `resolveItemCreditIds({strict:true})` | **abstention**: the attribution oracle could not answer, and the code's own comment says *"spend nothing this tick rather than rank against a second opinion"* | ❌ |

`scoreableDocs` filters on `!!d.memberId`, so an identity-mapping regression that returns a null
`primaryId` for everyone empties `allScoreable` **without any query error** — strict mode propagates
DB errors only (`lib/attribution/contributor-credit.ts:125-126`). Clearing on `:237` would silence a
standing alarm on the word of a pass that could not attribute anything.

**So the rule is not "these labels" but this property:**

> A pass may clear only if it **read the corpus successfully and found no work demanded**. A pass that
> abstained, was gated, or could not evaluate must record nothing.

| outcome | clears | why |
|---|---|---|
| `nothing-to-score` **@:206** | ✅ | read the window, nothing scoreable |
| `no-candidates` @:195 | ✅ | read the tasks, none to offer |
| `unchanged` @:270 | ✅ | every eligible doc already answered |
| `nothing-to-score` **@:237** | ❌ | the credit oracle abstained |
| `cooldown` @:147 | ❌ | the pass never ran |
| `no-llm` @:151 | ❌ | unconfigured — a different state, and its own signal |

⚠️ **And the justification is narrower than round 0 claimed.** An idle pass does **not** prove the
provider recovered — `lib/llm/complete.ts:212` makes exactly this argument in-repo (*"`ok: true` would
claim a model that was never asked"*), and `timeline-summary` succeeding proves some OpenRouter
workload works, not this leg's model role, prompt size or parsing. What it proves is only: **there is
no output currently demanded, so a historical provider failure must not drive a present-tense alarm.**
That is sufficient, and it is what the spec claims.

### 2b. Record unconditionally after the cooldown — the round-0 conditional was racy AND rested on a wrong number

Round 0 wrote the clearing row **only when the newest row was a failure**, to avoid noise. Both halves
of that were wrong:

- **The noise estimate was wrong.** I assumed a row every 30 minutes. The **cooldown gate runs first**,
  and a newly written success *becomes* the cooldown clock — so the steady-state cost is **~2 rows per
  team per day**, not 48. The entire reason for the conditional evaporates.
- **The conditional is a check-then-insert race.** Two callers exist and they are **not** mutually
  single-flighted: the scheduler (`lib/ingest/scheduler.ts:91`, single-flighted only against itself)
  and the timeline rebuild on a dashboard read (`lib/dashboard/timeline-cache.ts:116`). Interleaving:
  idle pass **A** observes "newest is a failure"; concurrent pass **B** finds work, calls the model,
  fails, records `ok=false`; **A** then records its authorised `ok=true`. `STREAK_SQL` takes newest —
  so **A's success masks B's real failure** and the alarm goes quiet on a genuinely broken leg.

So: record the clearing outcome **unconditionally once past the cooldown**.

⚠️ **That alone does not close the masking window** — Codex's proposal stopped here, and it should
not. Unconditional recording still lets A's `ok=true` land after B's `ok=false`; the rows are merely
both truthful. What actually closes it is a **guarded write**: the clearing row is inserted only if no
row for this `(source, team_id)` has been recorded since this pass started. A concurrent failure
therefore always wins, and two concurrent *idle* passes may both write (harmless — both `ok=true`, the
streak stays broken).

⚠️ *Note the ordering asymmetry this must respect: `STREAK_SQL` breaks ties with `finished_at desc,
id desc` (`lib/ingest/pipeline-health.ts:345`) while `lastRun` orders by `finished_at` alone
(`doc-task-infer-run.ts:450`). The guard must not assume they agree.*

### 2b-bis. The accepted cost: clearing takes up to one cooldown

Every clearing outcome sits **behind** the 12h cooldown gate, and the cooldown counts failed runs. So
after this ships a healed failure can stay loud for **up to 12h + one tick**, and the clearing row
itself resets the cooldown, deferring the next real scoring pass by up to 12h. Both are accepted and
stated here **so that "still red 6h after the top-up" is not read as this fix having failed.**

### 2c. The false comment is corrected

§0d's sentence is replaced with what is actually true, naming this mechanism.

### 2d. The other legs: fix `doc_task_infer` alone — and record WHY, so the next one is recognised

Round 0 listed six same-shaped legs and asked the reviews to decide. Both said fix this one alone, and
the inventory itself was wrong:

- **`pret3_sweep` is already fixed** (§0f) — my draft listed it as unfixed.
- **The rest mostly SELF-CLEAR**, because their failure leaves pending work that survives the heal:
  `dense` and `graph_project` retry the same backlog and record `ok=true` on the healing run; `arcs`
  persists no reusable hash on failure (`lib/graph/arcs.ts:679,859`), so the retry re-runs the model
  and records.
- **`linear_inbound` is the one genuinely unverified twin** — named here, not fixed here.

`doc_task_infer` is unique in that **healing removes the reason to record**: the work it failed on was
never pending in the first place. That distinction goes into the §2c comment so the next leg with this
shape is recognised rather than rediscovered.

⚠️ **A residual, named rather than fixed:** a team that REMOVES its keys while `confirmed` keeps the
banner forever, because `no-llm` never clears. That is the `no-llm` analogue of `isOrphanedConnector`
and is the likely next BANNERSTUCK. Out of scope here; recorded so it is a known cost.

## 3. Scope

**In:** `lib/dashboard/doc-task-infer-run.ts` (the three clearing outcomes) · the corrected comment
in `lib/ingest/pipeline-health.ts` · a guard · a data-mechanics test · `docs/ARCHITECTURE.md` if the
ingestion-health prose is affected.

**Out:**
- **Any new duration constant, grace period or age-out** — rejected by BANNERFLAP-1 §3a (§0e).
- **`STALE_MS_BY_SOURCE`** — the `null`s are correct and stay.
- **`FAILURES_TO_CONFIRM`** — not a tunable, by its own measurement.
- **The other five legs**, pending §2d.
- **The `unconfirmed`-stays-quiet cost** of §3a — a different, accepted trade.

## 4. Acceptance

⚠️ **Fixture requirements that decide whether these can pass at all** (Fable): AC1–AC3 must seed
answering keys against the stubbed model, or the pass returns `no-llm` at `:151` before reaching any
clearing branch — and a builder who hits that first may "fix" it by clearing there, which is the
hole AC2b exists to close. AC4's failures must be produced by **running** the pass (stubbed model
returns null → `ok=false` at `:351`), **not** by seeding rows: a seeded-only fixture lets a mutation
that flips the failure record to `ok=true` survive.

- **AC1 — each clearing outcome clears, all three (data-mechanics, real Postgres):** seed a confirmed
  streak (≥2 `ok=false`), then, **once per outcome** — `nothing-to-score`@:206, `no-candidates`@:195,
  `unchanged`@:270 — run a pass and assert via **`getPipelineHealth`** that the leg leaves `failing`
  and is no longer `confirmed`; and assert the pass returned that exact `skipped` value and inserted a
  row with `ok=true` and `meta.skipped=<reason>`. *Round 0 tested only one outcome, so an
  implementation with two of the three still stuck passed every criterion. Asserting the inserted row
  stops an unrelated seeded success from satisfying the health read.*
- **AC2 — `cooldown` does NOT clear (data-mechanics):** seed the streak with its newest failure
  **inside** the cooldown window; the pass returns exactly `cooldown`, **row count is unchanged**, and
  the leg is still `confirmed` and still in `failing`. *If this cleared, the alarm could be silenced
  by doing nothing — strictly worse than the bug.*
- **AC2b — `no-llm` does NOT clear (data-mechanics):** same seed, no answering keys; the pass returns
  exactly `no-llm`, row count unchanged, leg still `confirmed`. *`no-llm` sits one gate ABOVE the
  clearing outcomes and is the easiest state to reach in this tier, so a write wired one early-return
  too high passes everything else.*
- **AC2c — the credit-oracle abstention does NOT clear (data-mechanics):** docs exist in the window
  but `resolveItemCreditIds` yields no `primaryId`, so `allScoreable` is empty at **`:237`**; row count
  unchanged, leg still `confirmed`. *Same `skipped` LABEL as AC1's `:206` case and the opposite
  meaning — this is the criterion that stops a broken attribution oracle silencing a real alarm.*
- **AC3 — the steady state writes nothing extra (data-mechanics):** with the newest row `ok=true` and
  **older than the cooldown** (so the pass actually reaches an idle branch), an idle pass returns that
  idle outcome and adds at most the one clearing row the design permits. *Round 0's version was
  vacuous: a recent success returns `cooldown` first, so row count stayed unchanged under both the
  intended implementation and a dozen wrong ones. The criterion must assert the RETURNED outcome.*
- **AC4 — a real failure is still loud (data-mechanics):** run the pass twice with the model stubbed
  to fail; both record `ok=false`, the leg is `confirmed` and in `failing`, and `failingSince` reports
  the **oldest** failure in the streak. *The fix must not buy quiet by weakening the alarm.*
- **AC5 — a concurrent failure is never masked (data-mechanics):** with a clearing pass and a failing
  pass released against the same team, the final state is **`failing`** regardless of completion
  order. *§2b's guarded write exists for exactly this, and it is the criterion Codex's "unconditional"
  proposal would have shipped without.*
- **AC6 — a failed READ never becomes an idle success (data-mechanics):** force the task read, item
  read, credit read and roster read to error in turn; each records `ok=false` (or records nothing) and
  **never** an `ok=true` clearing row. *The clearing outcomes are defined by "read successfully and
  found nothing" — a read that threw satisfies neither half.*
- **AC7 — no time-based escalation (guard, unit + behavioural):** classification is **identical** at
  two widely separated failure ages with no intervening run — the observable, not a grep. *Round 0
  used a `*_MS`/`*_HOURS` source scan, which an inline `86_400_000` walks straight past.*
- **AC8 — the false comment is gone AND the true one is pinned (guard, unit):** `pipeline-health.ts`
  no longer asserts that a persistent failure keeps re-recording, and does state the narrower claim.
  *Deleting the sentence alone would satisfy a "does not contain" check while leaving the map silent.*

| # | mutation | must redden |
|---|---|---|
| 1 | the clearing row is never written | AC1 |
| 2 | only `nothing-to-score` clears; `unchanged`/`no-candidates` still stuck | **AC1** (the per-outcome legs) |
| 3 | `cooldown` also writes the clearing row | **AC2** |
| 4 | the write is wired above `:151` so `no-llm` clears | **AC2b** |
| 5 | `:237` (oracle abstention) clears, i.e. both sites treated as one label | **AC2c** |
| 6 | the clearing row is written with `ok=false` | AC1 |
| 7 | the guarded write drops its guard (plain unconditional insert) | **AC5** |
| 8 | a read error is swallowed into an idle success | **AC6** |
| 9 | `FAILURES_TO_CONFIRM` raised so nothing ever confirms | AC4 |
| 10 | `failingSince` reports the newest failure instead of the oldest | AC4 |
| 11 | add an inline elapsed-time escalation (real shape, not a named constant) | **AC7** |
| 12 | restore the "a persistent failure keeps re-recording" sentence | AC8 |

## 5. Risks

| risk | direction | mitigation |
|---|---|---|
| The alarm can be silenced by a leg that never ran | **a real break goes unreported** — worse than the bug | AC2/AC2b + mutations 3/4: only a pass that READ SUCCESSFULLY and found no work may clear |
| A broken attribution oracle silences the alarm | the sharpest version of the above — same `skipped` label, opposite meaning | §2a splits `:206` from `:237`; AC2c + mutation 5 |
| A concurrent failure is masked by a clearing row | the alarm goes quiet on a genuinely broken leg | §2b's guarded write; AC5 + mutation 7 |
| `ingest_runs` fills with idle rows | the operator's run log becomes unreadable | bounded by the cooldown to ~2 rows/team/day (§2b) — measured, after round 0's estimate of 48/day was wrong |
| "Still red hours after the fix" reads as the fix failing | a correct implementation gets re-opened | §2b-bis states the ≤12h+tick clearing latency up front |
| A later tweak reintroduces a grace period | the exact fix §3a proved wrong | AC5 is a ∀ guard, mutation 7 |
| Fixing one leg and leaving five | the same defect ships five more times | §2d is an open question for the review, not a silent choice |
| A unit stub of the streak query passes while the real SQL does not | green by construction | AC1–AC4 are **data-mechanics**, against real Postgres and the real `STREAK_SQL` |

## 6. What would falsify this

If `doc_task_infer` on prod records a **successful** run before this ships — i.e. a scoreable doc
arrives — the banner clears on its own and the incident looks self-healing. **That would not falsify
the defect**, only hide it: the mechanism in §0c is unchanged and the next healed-but-idle failure
reproduces it. The measurement to re-take at build time is §0a's streak, not the banner's colour.

**Nothing is built. No code exists for this slice.**
