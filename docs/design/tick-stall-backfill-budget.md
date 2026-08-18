# One stage starves the rest of the tick (TICKSTALL-1)

Status: **approved for build** — two independent cold reads, both BLOCKED, both folded (Fable: the
resume mechanism did not exist, permanently-unconverged would be silent, multi-team starvation; Codex:
`ingest_runs.meta` is not race-free without single-flight, the alarm false-positives on a benign race,
split at the alarm boundary) · Owner: chetan
· Tier build-with: data-mechanics (the partial-drain/resume outcome) + unit (the budget parse + the call-site metrics)

**Deps:** none — cuts from `main` after BANNERFLAP-2 (#585) merged.

**Increment:** ONE PR = **single-flight on the tick**, a per-tick TIME BUDGET on the context-backfill
stage, a resumable cursor, team rotation, and honest `ingest_runs` metrics. No change to the
convergence heuristic, no new alarm, no schema change, no new surface.

**Split at the alarm boundary (both spec reviewers, independently).** An earlier draft also added a
"drained but predicate still false → `ok:false`" escalation. That is now **TICKSTALL-2**, together
with the heuristic fix it serves — the two are the same conversation, and bundling a NEW failure mode
into the outage fix is what would make this PR unshippable on its own. The outage fix stands alone;
the alarm needs the metrics this PR adds before it can be built correctly at all.

## Problem

The ingest scheduler tick is one sequential `await` chain (`lib/ingest/scheduler.ts`). One stage in
the middle of it — `runContextBackfill` — can take **57–60 minutes**, against a **30-minute** tick
interval (`INGEST_POLL_MINUTES`, default 30). `setInterval` has no re-entrancy guard
(`lib/ingest/scheduler.ts`), so ticks overlap while it runs, and every stage sequenced AFTER it does
not run at all.

Measured on prod, inside one outage window (2026-08-17 04:27→09:18 UTC), counting `trigger='scheduler'`
rows per source:

| leg | position in the chain | rows recorded during the 4.9h gap |
|---|---|---|
| `slack` / `linear` / `linear_inbound` | before the backfill | **13** |
| `github` / `access_bootstrap` | before the backfill | **7** |
| `context_backfill` / `context_backfill_all` / `meeting_notes` / `doc_task_infer` / `dense` | at or after | **0** |

13 rows in 4.85h is *more* than the ~9.7 a 30-minute interval predicts — that is the overlap, not a
faster poll. So while this is happening: **meeting-notes extraction, task-evidence linking, doc-task
inference, dense (semantic) indexing and the graph-health alarm do not run for hours at a time.**

**Six such outages in 14 days** (131 / 157 / 191 / 213 / 246 / 293 min), **all of them after
2026-08-11** — the day `runAccessBootstrap` (`3a809fb1`) and `runContextBackfill` (`d3cb8e2c`) joined
the chain. Zero in the preceding week, *including* days with 15 and 12 merges. So this is a regression
from that change and **not** deploy volume — 2026-08-04 had 15 merges and no outage.

### Why the cost is bimodal, not gradual

`backfillAllTeams` (`lib/projects/context/backfill.ts`) opens with a cheap convergence short-circuit:
it compares `count(items)` against `count(project_context_memberships where valid_to is null)` and, if
memberships ≥ items, skips the team entirely (~2 counts). Otherwise it runs a full O(N) cursor drain.

Measured hourly stage duration for `context_backfill_all` confirms exactly that shape — **0.0 min or
~59 min, nothing in between**:

| window (UTC) | avg stage min | max |
|---|---|---|
| 2026-08-17 09:00–22:00 | 19.7 – 58.4 | **60.1** |
| before 09:00 and after 23:00 | 0.0 | 0.0 |

So the outage is not "the backfill got slower". It is **the short-circuit stopped firing**, and the
un-short-circuited path costs an hour.

### Three defects underneath, only ONE of which this PR fixes

1. **No time budget.** The stage drains to completion or not at all, so any genuine backlog starves
   every downstream stage by construction. **This is what this PR fixes.**
2. **The convergence heuristic compares two different grains** — `items` is per item;
   `project_context_memberships` is per (project, context_unit) — so it can be permanently
   unsatisfiable. It is unsatisfied **right now**: 2656 items vs 2655 active memberships, a deficit of
   one row, which pins an hour-long O(N) sweep onto every 30-minute tick. **Deliberately NOT fixed
   here — see Scope.**
3. **The leg's `created` metric is dead.** Both `recordIngestRun` calls in `runContextBackfill`
   hardcode `created: 0`, so every row reads `created=0` whether the pass drained 2600 items or did
   nothing for an hour. That is *why* this ran for six days unnoticed: the only honest signal was the
   `finished_at - started_at` span, which nothing reads. **Fixed here.**

## Decision

**1. Give the scheduler's backfill stage a wall-clock budget** (`CONTEXT_BACKFILL_BUDGET_MS`, default
**5 minutes**), checked AFTER each batch. On expiry the pass stops and reports `truncated: true`.

**The budget lives in `backfillAllTeams` — never in `backfillTeamContext`.** That single placement
decision is what keeps the other two caller families whole: `drainTeamContext` (the enforcement flip,
which documents having no short-circuit *because* a caller about to change what a team can see needs a
real drain) and `runContextBackfillAction` (`app/t/[team]/admin/access/actions.ts` — an admin who
clicks "backfill now" expects a real drain, not a 5-minute slice).

**2. SINGLE-FLIGHT on the tick is a PREREQUISITE, not a follow-up.** An earlier draft cut the
`setInterval` re-entrancy guard as a separate concern while simultaneously introducing a shared
mutable cursor — i.e. it added coordination state and declined the coordination. That contradiction is
this slice's sharpest correction. `setInterval(tick, intervalMs)` (`lib/ingest/scheduler.ts`) starts a
new tick regardless of whether the last one finished, so without a guard two passes can read the same
stored cursor, redo the same batch, and race their "newest row" writes — and a stale pass finishing
after a drain can RESURRECT a superseded cursor. `recordIngestRun` is append-only and best-effort and
swallows its own write failures (`lib/ingest/runs.ts`); it offers no compare-and-swap to build on.

So the tick gets an in-flight flag: a tick that fires while one is running returns immediately. With
exactly one pass in flight, the cursor has a single writer and everything below is sound. This also
retires the overlap measured in the Problem section (13 `slack` rows in 4.85h against ~9.7 expected).

**3. The cursor must SURVIVE the tick — the first draft asserted a resume mechanism that does not
exist.** `backfillAllTeams` sets `cursor = null` per team per call
(`lib/projects/context/backfill.ts`), so a budgeted stop would restart from the beginning of the
corpus every tick, re-reconciling the same first batch forever and never reaching the tail. The
budget is worthless — actively harmful — without this:

- **Home:** `ingest_runs.meta.cursor` on that team's newest `context_backfill` row, read with an
  explicit `order by finished_at desc, id desc` — the tie-break `lib/ingest/pipeline-health.ts`
  already had to learn, because rows can share a timestamp and without it the cursor is
  nondeterministic under same-millisecond writes. No schema change, and it survives a deploy, which
  in-memory module state would not: at ~15 deploys/day an in-memory cursor would reset before a
  ~12-tick pass could finish.
- **Honest about the precedent:** the `graph_health` ledger (`lib/graph/extraction-alert.ts`) does
  keep durable state in `ingest_runs.meta`, but it is a LOW-FREQUENCY transition ledger read for prior
  alarm state — not a work cursor advanced every tick. The analogy establishes that `meta` is an
  accepted home for durable state, and nothing more; it is decision 2's single-flight, not the
  precedent, that makes this safe.
- **Reset on drain:** when a pass reaches the end of the corpus the stored cursor returns to `null`.
  Without the reset, an item the on-push hook misses whose id sorts BELOW the final cursor is never
  swept again — a unit with no membership, i.e. content visible to nobody under an enforced read.
  That is the silent-forever direction, and it is why criteria 3 and 4 exist.

**4. Fairness by ROTATION, not by a per-team floor.** `backfillAllTeams` loops teams sequentially, so
a stage-wide budget plus a team that never converges (prod's condition today) starves every later team
permanently. Teams are served **oldest-served-first**, specified so the bound is checkable:

- The rotation clock is the team's newest `context_backfill` row with `trigger='scheduler'`; a team
  with NO such row sorts first; ties break by `team_id` so the order is total and deterministic.
- **Every served turn writes a row** — success, truncated, short-circuited or failed alike — so a
  served team always leaves the front of the queue. This is also why a FAILING team cannot monopolise:
  its failure row updates the same clock. (The earlier draft worried it could; the second reviewer
  refuted that, and the refutation is recorded here rather than silently dropped.)
- **Observable bound:** every team is served within `team_count` scheduler passes.

A per-team one-batch floor was the alternative and is rejected: it bounds the stage at
`teams × batch-time`, i.e. unbounded in team count, which defeats the budget.

**Bound, stated rather than implied:** the stage runs at most `budget + one batch`. A batch that has
started runs to completion, so the scheduler passes `batchSize: 100` (not the 500 default) to keep the
overshoot near one batch rather than ~11 minutes at the measured ~1.3 s/item.

**Minimum one batch per team-turn**, checked AFTER the batch. A budget of 0 (mis-set env, clock skew)
must not halt the sweep forever at zero progress — "at most one batch" is satisfied by none, which is
a stall wearing a budget's clothes.

**4. Budget-truncated is NOT failed.** The stage records `ok: true` with `meta.truncated: true`. A
partial pass has broken nothing, and routing it through the failure path would put a healthy leg into
the `BANNERFLAP-1` streak and redden the banner — re-introducing the bug the sibling ticket just
fixed. **Implementer trap:** `backfillAllTeams` sets `drained = true` on FAILURE as a "don't also
report guard-exhaustion" flag; a naive budget break falls through to the `guard exhausted` failure and
lands in exactly the path this criterion forbids.

**5. `truncated`, `shortCircuit` and `drained` are three different facts and get three names.** The
first draft called the flag `converged`, which lies: it would have meant "this call hit the budget",
while a reader takes it as "this team satisfies the convergence predicate" — and the next tick's count
check can contradict it immediately.

**6. The "drained but still unconverged → `ok: false`" alarm is CUT to TICKSTALL-2 — and the reason is
a defect, not just size.** The intent stands: a permanently unconverged team is otherwise **green and
fresh forever**, because `ok: true` keeps `failureClass: "ok"` AND refreshes the very scheduler
heartbeat the staleness clock reads. That is BANNERFLAP's alarm-death one level up and it must be
closed. But the predicate as drafted **false-positives on a benign race**: the drain is cutoff-scoped
(`items.created_at < cutoff`), while the convergence counts are global and un-scoped
(`lib/projects/context/backfill.ts`). An item inserted DURING the pass is deliberately excluded from
the sweep yet counted by the predicate, so a healthy pass records `ok: false` — a brand-new false
alarm, in the slice whose sibling ticket exists to delete false alarms.

Getting it right means scoping the alarm to the drained corpus, or better, asking directly whether any
pre-cutoff item is uncovered rather than comparing two global counts. That is the same question
TICKSTALL-2 has to answer for the heuristic itself, so the two belong together — and both need the
metrics below before either can be built on evidence. **Recorded so the naive version is not
re-proposed.**

**7. Replace the hardcoded `created: 0`** with what the pass actually did, PER TEAM: `created` =
memberships created, plus `meta.scanned`, `meta.unitsCreated`, `meta.truncated`, `meta.drained`,
`meta.shortCircuit`, `meta.cursor`, `meta.elapsedMs`. `backfillAllTeams` returns binary
`succeeded`/`failed` today and a truncated team is neither, so the return shape gains a per-team
outcome list — that change is in scope and is what makes per-team counts available at the call site
at all.

### Why the heuristic is NOT fixed in this PR

It is the obvious fix and it is the wrong one to do blind. The heuristic's failure directions are
asymmetric:

- Too **strict** (today): a needless O(N) sweep. Costly, now bounded by the budget above.
- Too **loose**: the sweep is skipped while items genuinely lack a membership. Under an enforced-read
  team those items are visible to **nobody** — content silently disappears.

Making it "correct" requires deciding what convergence means across a grain mismatch, and the cost of
guessing wrong is data invisibility, not slowness. With the budget in place the strict direction stops
being an outage and becomes a measurable inefficiency — and the metrics from decision 3 are what make
the next slice decidable instead of speculative. Same discipline as RECONCILE-1: measure, then enforce.

## Scope

**In:** single-flight on the tick; the budget (one env parse, one default, checked after each batch);
the cross-tick cursor in `ingest_runs.meta` with reset-on-drain and a deterministic newest-row read;
team rotation with a stated bound; the per-team outcome shape through `backfillAllTeams` →
`runContextBackfill`; the real `ingest_runs` metrics; tests.

**Cut, each with the reason:**
- **The convergence heuristic's grain mismatch** — above. The single highest-value follow-up, and the
  metrics this PR adds are its prerequisite. **The honest cost of deferring it: ~5–7 minutes of every
  30-minute tick spent on no-op re-scans, indefinitely**, because prod is unconverged today and stays
  so until that slice ships. Stated plainly rather than left as "bounded": it is a real, permanent tax
  until then. It is still the right trade — the downstream legs run again, the outage becomes a
  bounded cost, and decision 6 makes the pathology loud instead of letting the tax go quiet.
- **The drained-but-unconverged alarm → TICKSTALL-2**, with the heuristic fix it serves. Decision 6
  records the false-positive that makes the naive version wrong, so it is not re-proposed.
  (The `setInterval` re-entrancy guard is NO LONGER cut — see decision 2. It moved INTO this slice
  because the durable cursor is unsound without it; an earlier draft cut it and added the cursor in
  the same breath.)
- **Revisiting BANNERFLAP-2's 6h staleness bars.** They were fitted to the tail this regression
  produces. Once the chain completes reliably the tail should collapse and those bars should be
  re-measured — but doing it now would fit them to a system mid-fix.
- **The ~1.3 s/item reconcile cost** implied by 2656 items in ~59 min. Recorded as an observation; it
  is a separate performance question and this PR neither measures nor changes it.
- **`drainTeamContext`** (the enforcement-flip path) is deliberately untouched: it documents having NO
  convergence short-circuit *because* a caller about to change what a whole team can see needs a real
  drain. A budget there would break that contract.

## Acceptance criteria

1. **unit** — a tick that fires while another is in flight returns WITHOUT running any stage, and the
   flag clears even when a stage throws (a guard that leaks a stuck `true` would wedge ingestion
   permanently — strictly worse than the bug being fixed).
2. **data-mechanics** — an ALREADY-EXPIRED budget still runs exactly one batch for the team it is
   serving (never zero) and records a resumable `meta.cursor`; the items it processed are durably
   partitioned. Fixture corpus must exceed one batch, and its size must NOT be derived from the
   batchSize constant under test.
3. **data-mechanics** — the cursor RESUMES across separate calls: successive budgeted passes advance
   PAST the first batch and eventually drain a multi-batch corpus. This is the criterion that
   falsifies restart-from-null, the defect that made the first draft of this spec unbuildable.
4. **data-mechanics** — a drained pass RESETS the cursor to null, and an item created AFTER that drain
   whose id sorts BELOW the old cursor still gains a membership on a later pass — the post-drain
   backstop, i.e. the "visible to nobody" direction.
5. **data-mechanics** — an item created MID-PASS (after the tick cutoff) whose id sorts BELOW the
   stored cursor is skipped by the resuming pass and then covered once a drain resets the cursor. The
   sharper half of criterion 4: it pins the actual window during which such an item is uncovered,
   rather than assuming "the next pass" catches it — which the resume logic does not do.
6. **data-mechanics** — the newest-row read that restores the cursor is deterministic under
   same-`finished_at` rows (`order by finished_at desc, id desc`), so two rows written in the same
   millisecond cannot make the resume point arbitrary.
7. **data-mechanics** — a converged corpus with a generous budget still takes the cheap short-circuit
   (no O(N) drain), so the existing optimization is pinned and this PR cannot have removed it.
8. **data-mechanics** — a budget-truncated team records `ok: true` with `meta.truncated === true`, so
   a partial pass does NOT enter the failure-streak path and cannot redden the banner.
9. **data-mechanics** — with N teams, every team is served within N scheduler passes even when the
   first team never converges — the observable bound that makes rotation checkable rather than
   asserted.
10. **unit** — `runContextBackfill`'s `recordIngestRun` call sites pass real per-team counts, and a
    guard fails the build if either reintroduces a hardcoded `created: 0` (the defect that hid this
    for six days).
11. **unit** — `CONTEXT_BACKFILL_BUDGET_MS` has exactly ONE parse site with a documented default, and
    a guard fails the build on a second parse (a diverging local parse is how two components silently
    disagree about a budget — the `PRET_FLIP_MAX_PER_TICK` precedent).

## What would falsify this

- **A downstream leg still recording zero rows for hours after this ships** — the outcome that matters.
  `meeting_notes` / `dense` gaps should collapse to the tick interval.
- A budgeted pass **losing** an item (an item that never gets a membership across repeated passes) —
  that would mean the cursor and the budget interact badly, and it is the dangerous direction here.
- The budget being **too small to ever drain** a real corpus: if `meta.drained` is never true across
  days of passes, 5 minutes is under-sized. Note the FIRST draft's version of this bullet watched
  `converged`, which is unfalsifiable in exactly the pathological state — under the stuck heuristic a
  full pass still completes every ~12 ticks and would report converged, breaking the streak of
  "false for days" while the pathology continued. Watch `drained` and the escalation row instead.
- **The cursor never advancing past the first batch** — the restart-from-null failure. Visible
  directly as a `meta.cursor` that repeats across consecutive rows.
- A partial pass reddening the pipeline banner — that would mean truncation leaked into the failure
  path.
- The tail this ticket blames not collapsing after the fix, which would mean the 59-minute stage was
  not actually what starved the chain.
