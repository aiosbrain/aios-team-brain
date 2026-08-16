# One row per PASS, not per call — LLMOBS-2 / the last widening gap

**Status:** spec, SECOND draft. Draft 1 was BLOCKED by both cold reads, and one blocker invalidated
half its scope: the doc-task premise was copied from a stale exemption reason instead of re-derived.
What was wrong is recorded in place so it is not re-proposed.
**Related:** `docs/design/answering-model-observability.md` (LLMOBS-1 — this closes the gap its §5
deferred), `docs/design/pipeline-banner-failure-confirmation.md` (BANNERFLAP-1 — the streak this
feeds).

---

## 0. What is wrong

LLMOBS-1 gave the answering-model leg real evidence, but deliberately left out the two **fan-out**
generation features — and they are the highest-volume ones:

| call site | shape | measured |
|---|---|---|
| `lib/dashboard/timeline-summary.ts:109` | one model call per **(person, day)**, re-run on every background rebuild | **37.9 calls/day** |

**Draft 1 also listed `lib/dashboard/doc-task-infer-run.ts` here, and that was wrong.** Its exemption
reason (inherited verbatim from `test/guards/llm-record-coverage.test.ts` and copied into the spec
without re-deriving) said "one call per scored doc". The code says the opposite, in capitals:
`doc-task-infer-run.ts:249-253` — *"ONE CALL PER WORKER, not one per batch… The call count is the
number of distinct people in the batch (2–3 in practice), not the doc count."* At 2–3 calls behind a
12-hour cooldown it cannot flood a 50-row panel, so it fails THIS SPEC'S OWN deferral test in §4
("one call per trigger, so a pass would be a row per call anyway — churn with no gain"). It therefore
gets an ordinary per-call `record:`, like the low-volume sites LLMOBS-1 wired, and the stale exemption
reason is corrected rather than propagated. Review caught it; the slice is smaller for it.

`recordLlmOutcome` writes ONE `ingest_runs` row PER CALL, and `listRecentIngestRuns` shows **50**
merged rows against a whole-table rate of 333.7 rows/day. Wiring `record:` at those call sites would
therefore make the operator's Recent-runs panel mostly timeline summaries within a day and a half —
which is why LLMOBS-1 deferred them rather than flooding the ledger.

**So the leg's founding failure mode is still open for the feature with the most calls.** A model
failing on every timeline summary today reads `healthy`: `completeTextOrNull` swallows the failure,
returns `null`, the caller degrades to no summary, and nothing anywhere records it.

## 1. A constraint discovered while scoping, which shapes the design

**The per-call rate of the failure mode this leg exists for is not measurable, because of this bug.**
Over 60 days of prod, `llm_failures` holds **0** rows for `timeline-summary` against **1,279**
`llm_usage` rows.

Draft 1 called those 1,279 "successful calls". Review corrected it, and the correction makes the
argument STRONGER: `completeText` meters an empty-output failure into `llm_usage` *before* it throws
(`complete.ts:243-267` — `metered = true`, which also suppresses the `llm_failures` row). So
`llm_usage` rows are ATTEMPTS, not successes, and carry no ok flag. The empty-output rate is therefore
invisible in **both** ledgers, not merely absent from one.

**One caveat on the 1,279, which review supplied:** `llm_usage`'s `source: "timeline-summary"` is
SHARED with doc-task-infer's meter (`doc-task-infer-run.ts:287`, reusing the slice rather than widening
a closed union), so that figure over-counts timeline proper. Nothing here is derived from it — it is
cited only to show the ledger cannot answer the question — but a number quoted without its caveat is
how a wrong band gets built later.

What the 0 rows DO measure honestly: the transport class. Timeouts and non-2xx from this path do file
to `llm_failures` (`complete.ts:343-353`; timeline-summary passes `meter:` at `timeline-summary.ts:111`),
so zero in 60 days is a real near-zero transport-failure reading — and irrelevant to the mode that
matters.

The consequence for this spec is concrete: **no design may depend on a per-call failure threshold**,
because any number would be invented rather than measured, and this repo's rule is that a constant
gating an alarm is measured or it is not shipped.

## 2. The decision

Aggregate at the **pass** — the caller's own unit of work — and write ONE `ingest_runs` row for it.
Scope is now ONE site: `attachPersonDaySummaries`, called once per rebuild from
`lib/dashboard/timeline-cache.ts:115`, with `db`/`teamId` in scope at that boundary.

### 2a. The shape

**SCOPED, not open/close** — the caller cannot leak a pass because it never holds one open:

    await withLlmPass({ db, teamId, task: "timeline-summary" }, async (pass) => {
      // …N calls, each passing `record: pass`…
    });

Draft 1 specified `beginLlmPass(...)` + `pass.finish()` plus a guard that "every call site has a
`finish()` in a `finally`". Review showed that guard is not implementable soundly and is not even the
right property: a source-text check passes `const pass = begin(); if (skip) return; try {…} finally
{pass.finish()}` — which leaks on the early return with the regex fully satisfied — and fails a
legitimate open-in-A/finish-in-B split. Text cannot check control flow, and this repo has already
learned that a guard pinning shape rather than the property is worse than none. `withLlmPass` deletes
the leak class instead of policing it: the `finally` lives once, inside the helper.

**The token is BRANDED.** It is passed in the same `record:` slot as a per-call record, and a token
built from `{ db, teamId, task }` would otherwise be structurally assignable to that member — so
TypeScript would not force a discriminant, and a wrong branch in `recordLlmOutcome` restores the
per-call flood with the coverage guard still green (`/record:\s/` matches `record: pass`). A unique
symbol-keyed brand makes the union discriminated at compile time, and `recordLlmOutcome` narrows on it
before doing anything else.

**Concurrency, stated because the repo's immutability rule pushes the other way.** The pass counters
are mutable state shared across `CONCURRENCY = 6` in-flight calls (`timeline-summary.ts:53,66`). That
is safe here only because the increments are synchronous within one event-loop turn — there is no
`await` between read and write. Said explicitly so a future refactor that introduces one knows what it
is breaking.

**Counting works through `completeTextOrNull`** because `recordLlmOutcome` fires inside `completeText`'s
catch, before the `OrNull` wrapper swallows. The whole design depends on that and draft 1 left it
implicit.

### 2b. `ok` means "not every call failed", and the partial rate is observational

The pass row is `ok: false` only when **every** call in it failed. Not a threshold — the question the
leg asks is "is the model producing output at all", and that is answerable without inventing a number
(§1). A pass of 40 calls where 39 succeeded is a working model; a pass where 0 succeeded is not.

The counts go in `meta` (`calls`, `failures`) so a partial rate is **visible without gating** — the
same observational pattern `entitiesPerEpisode` uses in the graph census, and for the same reason: a
band that has never been measured must not move an alarm.

**The pass row also carries `meta.model` and a representative error, and that is not optional.**
`deriveTaskHealth` reads `meta.model` to name the failing model (`llm-health.ts:351`) and
`degradedNote` keys the reasoning-starvation hint off `lastError` (`:249-257`). A row without them
makes the degraded copy drop the model name and the "pick a non-reasoning model" hint — reinstating,
through this slice, the wrong-picker misattribution LLMOBS-1 existed to remove. Review caught that
draft 1 specified only `task`/`calls`/`failures` and pinned neither in its criteria. The model is
stable within a pass (`selectLlmBackend` is deterministic per keys/role) so one value is honest; the
error recorded is the FIRST failure's, and the count in `meta.failures` is what says how many more
there were.

**The accepted cost, at its real strength.** Draft 1 priced this as "a pass failing 50% of its calls
reads ok". That understated it twice over, and both reviewers said so:

- Within one pass, **a single success clears it** — 1 of 40 succeeding reads `ok`, not 50%.
- Across passes, BANNERFLAP-1 needs **two consecutive all-fail passes** to confirm. For
  timeline-summary that is ~80 consecutive call failures, and one trivial success (the model manages a
  one-line prompt for a quiet person-day) resets the streak. So a sustained 95% outage may never reach
  even `unstable`.

That is the honest bound, and it is still strictly better than today's 100% invisibility. It is
accepted rather than fixed because the alternative — "any failure fails the pass" — risks a
permanently red leg if the per-call transient rate is non-trivial, and §1 says that rate is exactly
what cannot be measured yet. The counts this slice starts recording are what a measured threshold
would later be derived from; that follow-up is named in §4.

### 2c. A QUIET pass writes nothing; a pass that FAILED BEFORE ITS FIRST CALL writes a failure

A pass that made zero calls because there was nothing to do — a rebuild with no content to summarise —
writes **no row at all**. `ok: true` would claim a model that was never asked; `ok: false` would accuse
on no evidence. An absent row also cannot break a real failure streak, which keeps BANNERFLAP-1 honest.

**But zero calls does not always mean "nothing to do", and draft 1 conflated the two.**
`attachPersonDaySummaries` returns `degraded: true` with zero calls when `resolveAnsweringKeys` throws
(`timeline-summary.ts:90-97`), and the code already labels that distinction itself: *"Couldn't even
find out which model to use — a failure, not a configuration choice"*, against a separate
`llmConfigured` branch returning `degraded: false` for "summaries are off by design". Under draft 1
that failure was an empty pass and therefore silent — and silent FOREVER, because `llm` has no
staleness clock (`STALE_MS_BY_SOURCE.llm` is null), is not a pipeline leg, and `TASK_RECENCY_MS` ages a
quiet task to `unknown` after 14 days. Both reviewers found it.

So a pass that fails BEFORE its first call records `ok: false` with `calls: 0`. It is a claim about a
model that WAS asked for and could not be found — evidence, not absence. The "off by design" branch
still writes nothing, because that one really is a configuration choice.

## Dependencies

**Deps: LLMOBS-1 (merged, `06c023e`).** This reuses its `LlmTaskName` vocabulary, its per-task streak,
and the coverage guard — whose exemption list is what this slice shortens.

## Build-with

**Build-with tier: Fable / high effort.** Justification: it changes the recording PRIMITIVE that four
merged call sites already depend on, so a regression reaches every task at once; the failure direction
is silence, which is the thing this family keeps having to re-learn; and the design deliberately
refuses a threshold, which is the kind of decision a reviewer should attack. Two adversarial review
rounds (Fable + Codex) plus a cold spec read.

## Tier safety

No tier surface changes. The pass writes through the same single writer
(`lib/ingest/runs.recordIngestRun`) with the same `team_id` scoping; it reduces the number of rows
written rather than widening any read. No new API route, no schema change, no change to
`visibleItems`/`visibleTasks`/`visibleGroupIds`. `meta.task` stays a fixed developer literal and the
new `meta.calls`/`meta.failures` are integers, never content.

## 3. Acceptance criteria

- `test/llm-pass.test.ts` — a pass of N calls where at least one succeeded records `ok: true` with `meta.calls` and `meta.failures` reflecting the real counts, and a pass where EVERY call failed records `ok: false`.
- `test/llm-pass.test.ts` — a QUIET pass (zero calls, nothing to do) writes NO row: neither a success claiming a model that was never asked, nor a failure accusing on no evidence.
- `test/llm-pass.test.ts` — a pass that FAILS BEFORE ITS FIRST CALL records `ok: false` with `calls: 0` — the key-resolution failure `timeline-summary.ts:90-97` already calls "a failure, not a configuration choice", which draft 1 would have made silent forever.
- `test/llm-pass.test.ts` — the pass row carries `meta.model` and the first failure's error text, so `degradedNote` can still name the model and attach the reasoning-starvation hint. Without this the copy LLMOBS-1 shipped silently loses both.
- `test/llm-pass.test.ts` — the callback's own throw still writes the pass row (the `finally` inside `withLlmPass`), and the throw propagates; the happy path never exercises that branch.
- `test/llm-pass.test.ts` — recording is idempotent: the helper writes exactly one row even if a caller ALSO finishes explicitly. Draft 1 justified this with "a `finally` after an early `return`", which review showed is impossible — a `finally` runs once. The real shape is a builder adding a defensive explicit finish alongside the mandated one.
- `test/guards/llm-record-coverage.test.ts` — a branded pass token is NOT structurally assignable to the per-call record shape, so `recordLlmOutcome` cannot silently take the per-call branch and restore the flood while the coverage guard stays green.
- `test/datamechanics/llm-pass-recording.datamechanics.test.ts` — real Postgres: a timeline rebuild covering several person-days writes exactly ONE `source='llm'` row with `meta.task = "timeline-summary"`, not one per summary — the flood this design exists to avoid.
- `test/guards/llm-record-coverage.test.ts` — the exemption list SHRINKS to `lib/social/generate.ts` alone: `timeline-summary` and `doc-task-infer` are recorded, and the existing stale-exemption check enforces that they are genuinely wired rather than merely delisted.
- `docs/ARCHITECTURE.md` — the `ingest_runs` row records that fan-out generation tasks write one row per PASS with `meta.calls`/`meta.failures`, that `ok` means "not every call failed", and that an empty pass writes nothing.

## 4. Scope

**In:** `withLlmPass` in `lib/llm/complete` (branded token, scoped lifetime), the ONE genuine fan-out
call site (`attachPersonDaySummaries`), an ordinary per-call `record:` at `doc-task-infer-run` with a
task slug that does not collide with its existing `source='doc_task_infer'` row, both new slugs added
to `LLM_TASK_NAMES` + `TASK_COPY`, the shortened exemption list, and the `docs/ARCHITECTURE.md` row.

**Naming, pinned so it is not invented:** the task slugs are `timeline-summary` and `doc-task-infer`
(hyphenated, matching every other member of `LLM_TASK_NAMES` and the hyphenated keys of `TASK_COPY`).
The underscored `doc_task_infer` stays what it is — the `ingest_runs.source` of that leg's own
pass-level row — and the two must not be confused: one is a pipeline leg, the other a `meta.task`
inside `source='llm'`. `recordLlmOutcome`'s hard-coded `trigger: "api"` is KEPT for pass rows, because
`lib/ingest/pipeline-health.ts:207` documents a dependency on `llm` rows carrying it; a
scheduler-driven pass labelled `api` is mildly imprecise and changing it would touch that query.

**Deferred, each with its reason:**

- **A partial-failure threshold.** Cannot be derived until this slice makes the data exist (§1). The
  counts ship observational so the derivation becomes possible; inventing a band now is the thing
  this repo's measured-not-chosen rule forbids.
- **Converting the LOW-volume call sites to passes.** `meeting-summary` and friends are one call per
  trigger, so a pass would be a row per call anyway — churn with no gain. `doc-task-infer` now falls
  in this bucket too, per §0.
- **Replacing doc-task-infer's existing `source='doc_task_infer'` pass row.** It already implements
  §2b's semantics at that site (`ok:false` only when "model returned null for every worker",
  `workers_failed` in meta for partial shortfall). The new `source='llm'` per-call rows are ADDITIVE
  and independent — one is "did this leg run", the other "is the model producing output". Collapsing
  them is a separate decision with its own blast radius on Recent-runs volume and streak independence.
- **A measured partial-failure threshold** — the follow-up §2b's accepted cost points at, once the
  counts this slice records make the derivation possible.
- **`lib/social/generate.ts`.** Still the product question LLMOBS-1 named; unchanged here.
- **Backfilling history.** The ledger cannot say what it never recorded.

## 5. What would falsify this

Wrong if the leg still reports healthy while timeline summaries are failing — the shape to check being
a pass whose calls all fail but which writes `ok: true`, or writes nothing at all because `finish()`
was skipped. The `finally` guard and the all-failed criterion are the two pins against that.

Wrong in the other direction if the ledger still floods: if Recent-runs becomes mostly `llm` rows
after this ships, the pass boundary is drawn too finely (per person-day rather than per rebuild) and
the fix is the boundary, not the recording.

And §2b is falsifiable by its own accepted cost: if prod shows a sustained partial failure rate that
never trips the leg, "not every call failed" is too weak a verdict, and the counts this slice starts
recording are exactly what a measured threshold would then be derived from.
