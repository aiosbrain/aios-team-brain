# The answering-model leg observes one feature and speaks for all of them — LLMOBS-1 / AIO-905

**Status:** spec, FOURTH draft. Draft 4 amends §3d on an explicit product decision from the owner:
"when generation is degraded, Pulse should say so and it should have a specific reason." Draft 3 left
Pulse silent and named the surface as a deferred product question; it is now IN scope (§3f).

**Status history:** THIRD draft. Drafts 1 and 2 were each BLOCKED by both cold reads. What was wrong and
what was decided instead is recorded in place, so the rejected shapes are not re-proposed. Draft 2's
blockers were narrower than draft 1's — one shared task string and one unenumerated consumer — and
both reviewers agreed the rest of draft 2 held against the code.
**Related:** `docs/design/pipeline-banner-failure-confirmation.md` (BANNERFLAP-1 — the same leg, the
same family), `docs/design/graph-stall-probe-liveness.md` (STALLPROBE-1),
`docs/design/census-sample-floor.md` (CENSUSFLOOR-1).

---

## 0. What is wrong

The Admin retrieval-health card renders an **"Answering model"** leg. Its degraded copy
(`lib/query/llm-health.ts:139`) reads:

> The answering model (X) recently failed to produce output — **Learning arcs and meeting summaries
> may be blank.**

The leg has **never observed a meeting summary**, and cannot: meeting extraction records nothing.

`lib/llm/complete.recordLlmOutcome` writes the `source='llm'` rows this leg reads, and fires ONLY when
a caller passes `record:` (`lib/llm/complete.ts:89`). Exactly one file does — `lib/graph/arcs.ts`, at
`:492` (task `arcs`) and `:641` (task `arc-coherence`).

Measured over every `source='llm'` row that has ever existed:

| task | runs | failures | first | last |
|---|---:|---:|---|---|
| `arcs` | 48 | 10 (20.8%) | 2026-07-16 | 2026-08-12 |
| `arc-coherence` | 17 | 0 | 2026-07-25 | 2026-08-12 |

Nothing else. `lib/dashboard/timeline-summary.ts`, `lib/meetings/llm-extract.ts`,
`lib/meetings/merge.ts`, `lib/dashboard/doc-task-infer-run.ts`, `lib/attribution/correction.ts` and
`lib/social/generate.ts` all reach the shared primitive and record **zero** rows.

**Two live consequences.** A **false claim** on an alarm surface (the note names meeting summaries on
evidence that does not exist), and the **silent failure the leg was built to end** — `llm-health.ts:5-9`
says it exists because "a reasoning model silently blanked the Learning page with zero signal", and
that same model blanking meeting summaries today reads `healthy`.

`arcs` is also the least representative task to generalise from: it is the only production caller
requesting `role: "reasoning"` (`arcs.ts:479`), so it fails on a mode — reasoning-budget starvation —
that the non-reasoning tasks structurally cannot hit.

## 1. What this ticket is NOT — a refuted premise, recorded so it is not re-proposed

This began as "de-multiplex `llm` by `meta.task`", on a BANNERFLAP-1 review hypothesis that failures
interleave with other tasks' successes so the confirmation streak never reaches two.

**Measured: it does not happen.** Of 10 `arcs` failures, **0** were followed by a different task's
success — causally, not coincidentally: `pruneIncoherentEvidence` (the `arc-coherence` call) runs only
on non-empty parsed arcs and early-returns before any LLM call when there are no prune candidates
(`arcs.ts:620-624`, `:923-929`), so a failed `arcs` writes no `arc-coherence` row. Both cold reads
independently verified this.

It becomes live the moment recording widens — which is why §3d lands in the same slice.

## 2. What draft 1 got wrong

Both reviewers blocked it, on overlapping grounds. Recorded because each shaped a decision below:

1. **The headline outcome was skippable.** §3a hedged on "call sites that have `db` + `teamId` in
   scope", and never named one. But `callMeetingsLLM` already takes `meter?: LlmMeterCtx` =
   `{ db, teamId, memberId? }` (`lib/meetings/llm-extract.ts:76-93`, `lib/costs/llm-usage.ts:39-43`),
   threaded from every production path (`meetings/refresh.ts:99`, `meetings/from-items.ts:186`,
   `app/t/[team]/meetings/actions.ts:77,282`, `meetings/action-items.ts:86`). The deferral bucket was
   **factually near-empty**, and a builder reading the hedge literally could exempt meeting extraction
   and ship — with the criterion "must not claim meeting summaries affected when no row exists"
   passing *trivially forever*. §3a now enumerates, and §4 pins it.
2. **Worst-across-tasks with no recency bound pins the leg red forever.** A task whose last two runs
   failed and which then never runs again is `confirmed` indefinitely — and this is the normal state
   of several tasks: `canReuseArcs` hash-skips, `doc_task_infer` legally silent for days, meetings
   only on upload. Today's single stream heals because *any* newer row clears it; per-task removes
   that healing path and draft 1 put nothing in its place. §3c.
3. **The loud pipeline banner was never mentioned.** `llm` is a leg in `getPipelineHealth`, whose
   `STREAK_SQL` partitions by `(source, team_id)` only. Widening would have created a **new flap
   mode**: one `meeting-extract` blip plus one `timeline-summary` blip = a source-level streak of 2 →
   the loud "ingestion legs are broken" banner, from two unrelated lone failures, in the anti-flap
   family. §3d.
4. **The fan-out sites would flood.** `attachPersonDaySummaries` calls the model once per
   (person, day). Measured: `timeline-summary` runs **37.9 LLM calls/day** against a whole-table rate
   of 333.7 `ingest_runs` rows/day, and `listRecentIngestRuns` shows **50** merged rows — so the
   operator's runs panel would be mostly timeline summaries within a day and a half. §5.
5. **The bounded `limit 2` read cannot host per-task**, task slugs are not operator copy, and
   `LlmHealth`'s fields would describe the wrong task. §3b, §3c.

## 3. The decision

### 3a. Widen the evidence to the low-volume tasks, ENUMERATED

These call sites ship recorded in this slice, each with a stable task string:

| call site | task string | measured volume |
|---|---|---|
| `lib/meetings/llm-extract.ts` — the summary/attendees pass | `meeting-summary` | within 3.0 calls/day |
| `lib/meetings/llm-extract.ts` — the action-items pass | `meeting-actions` | within the same 3.0 |
| `lib/meetings/merge.ts` (`mergeTranscriptsLLM`) | `meeting-merge` | within the same 3.0 |
| `lib/attribution/correction.ts` | `attribution` | <1/day |

`meeting-summary` is the point of the slice: it is the feature the false claim names, and the one
whose silent failure §0 is about.

**The two meeting passes get SEPARATE task strings, and draft 2's reason for sharing one was a
rationalisation that rebuilt the very bug this slice removes.** Draft 2 said sharing avoided "a second
rarely-run task for §3c to age out" — but §3c ages by RECENCY, not rarity, and both passes fire on the
same trigger, so a split task always carries the same newest-run age. The reason was void, and both
reviewers then showed what it cost: the passes run back-to-back unconditionally on every production
trigger (`meetings/actions.ts:77→132`, `refresh.ts:99→127`, `from-items.ts:186→241`,
`merge.ts:250→257`), and **action items runs LAST**. So a failure mode that hits only the summary pass
— reasoning starvation is output-length-sensitive, and summary is the large-output pass — produces
`fail(summary), ok(actions)` per upload under one task string. The task's newest row is then ALWAYS
`ok`, so the leg reads `healthy`, not even `unstable`, while every meeting summary is blank. That is
§0's silent failure reconstructed for the exact feature the ticket names, and it is this spec's own §6
falsifier ("a partition that is not partitioning").

Note the structural contrast with §1's refutation, which does NOT apply here: `arc-coherence` is
causally gated on a successful `arcs`, so a failed `arcs` writes no masking row. The meetings passes
have no such gate — the mask would be guaranteed, not occasional.

Deliberately NOT recorded here — the fan-out sites — see §5.

### 3b. Narrow the copy to what was actually observed

The degraded note names the task that actually failed, resolved through an explicit
slug → operator-copy map (`arcs` → "Learning arcs", `meeting-summary` → "meeting summaries", `meeting-actions` → "meeting action items", …) with
an explicit fallback for an unmapped slug ("a background task (`<slug>`)"). The fallback matters
because §4's coverage guard guarantees new slugs keep appearing.

When more than one task is confirmed-failing the note names **all** of them, not the newest — a
one-task sentence during a two-task outage is the same under-claim this slice exists to remove.

**`LlmHealth` gains a per-task breakdown**, because draft 2 was not implementable: it required the
note to name every confirmed-failing task while every field stayed singular (`lastModel`,
`lastError`, `lastFailedAt`), and the card renders one detail line. Both reviewers flagged the
contradiction; with `arcs` failing on the reasoning model and `meeting-summary` on the query model,
the note must name both and the fields can describe only one.

    tasks: { task: string; state: LlmHealthState; model: string | null;
             lastFailedAt: string | null; lastError: string | null }[]

The leg state is the worst across participating tasks (§3c). The singular fields are RETAINED and
defined as **the newest failing row across tasks** — deterministic, and back-compatible with the
card's existing single detail line. The note names every confirmed-failing task, each with its own
model, so a two-task outage cannot be fronted by one model's name.

This also fixes what draft 1 got wrong in the other direction: taking `lastModel`/`lastFailedAt` from
whatever ran last, so a `meeting-summary` outage beside a fresh `arcs` success would have named arcs'
model. Those genuinely differ — arcs runs `teams.reasoning_model`, everything else the query model.

### 3c. Per-task streaks, with a recency bound

`getLlmHealth` computes a streak per `meta.task` (reusing `lib/ingest/failure-streak`'s
`foldStreak`/`classifyFailure` — the same primitives BANNERFLAP-1 shipped, not a reimplementation),
and the leg's state is the **worst across participating tasks**.

**A task participates only if its newest run is within `TASK_RECENCY_MS` (14 days).** Older than that,
the task is aged out of the verdict entirely. This is the answer to draft 1's blocker: without it, two
`meeting-extract` failures in March leave the card degraded in August, naming a feature nobody has
used since, unfixable by any action except uploading a meeting.

**Windowing is TASK-LEVEL, not row-level** — a task participates if its NEWEST row is inside the
window, and its streak is then computed over that task's rows without a further age filter. The two
grains classify differently and both reviewers flagged that the criterion passed either: a newest
failure yesterday with the previous failure 16 days ago is `confirmed` under task-level and
`unconfirmed` under row-windowing. Task-level is chosen because the streak's question is "has this
task failed repeatedly", and a 16-day-old failure is still the last thing that happened to that task.

**When NO task participates** — rows exist but every task's newest run is older than the window — the
leg is `unknown`, and the card's existing "no recent activity recorded" copy is, for once, exactly
true. The singular fields show the aged-out data (it is the newest thing there is) but the leg makes
no health claim from it.

**Ageing out only ever silences, never accuses**, and the transition is one-way per quiet period: a
task that ages out cannot re-enter without a new run, and a new run resets the verdict on fresh
evidence. So there is no flap at the boundary. The residual cost is real and bounded: an `arcs`
failure followed by a fortnight of `canReuseArcs` hash-skips ages off the CARD — but the `arcs`
PIPELINE leg has no recency window and stays confirmed on the loud banner, which is the backstop.

14 days is chosen against the measured cadences — `arcs` ran 48 times in 27 days, `meeting-extract` 42
times in 14 — so a genuinely-live task always has a run inside the window, while a task that has gone
quiet for a fortnight has no current claim on an operator's attention. It is a **first value, stated
as such**: if prod shows a live task aging out, the response is to widen the window, not to remove it.

The read becomes a per-task windowed query (`row_number() over (partition by meta->>'task' order by
finished_at desc, id desc) <= FAILURES_TO_CONFIRM`), not the current global `limit 2` — which after
widening would return two rows of the chattiest task and starve a failing one. `STREAK_SQL` in
`lib/ingest/pipeline-health.ts` is the in-repo precedent for the shape, including the `id desc`
tie-break.

### 3d. `llm` leaves the loud ingestion banner

`getPipelineHealth` includes `llm` as a leg in the banner that reads **"N ingestion legs are broken —
the brain isn't getting fresh data."** That sentence is false for this leg: ingestion is fine, a
generation task failed. It is also the surface BANNERFLAP-1's incident was reported on — a model blip
painting Pulse red is exactly what that ticket was raised about.

So `llm` is removed from the pipeline banner's legs, joining `GRAPH_HEALTH_SOURCE` as a source the
banner does not speak for. This is not a workaround for §3c being card-only: it removes the
false-aggregation flap mode in §2.3 permanently, at its root, rather than teaching a second surface
to partition by task.

**The stronger argument, which draft 2 missed and review supplied: keeping `llm` on the banner
DOUBLE-COUNTS every arcs failure.** A failed synthesis writes both a `source='arcs'` ingest row and,
via `record:`, a `source='llm'` row (`arcs.ts:485-495`) — so one event lights two legs. That is
literally the "2 ingestion legs are broken" of the 2026-08-11 incident BANNERFLAP-1 was raised for.
The codebase already knows and works around the symptom rather than the cause: `arcs.ts:487` tunes a
timeout specifically so "a slow-but-healthy reasoning model" does not "fire the loud pipeline banner".
Removing the leg removes the double-count at its root.

**What replaces it.** Draft 3 stopped here and left Pulse silent on generation, naming the surface as
a deferred product question. The owner has decided it: **when generation is degraded, Pulse says so,
with a specific reason.** So the leg is not deleted from the home page — it is moved off the
*ingestion* banner, whose sentence is false for it, and onto its own truthful surface (§3f).

Draft 2 also had the cost backwards, which is worth recording: Pulse loses no signal it HAS — today
the `llm` leg carries only arcs rows and the `arcs` leg, which stays, already covers those. The gap
was always about the NEW evidence §3a creates, and §3f closes it.

`arcs` remains a pipeline leg: that leg has independent per-synthesis value, and its own
ingestion-framing problem is pre-existing rather than created here. Answering it is the same question
for a different source, one at a time.

**In-code claims this invalidates, to be corrected in the same change:** the
`STALE_MS_BY_SOURCE.llm` comment "(also surfaced on the retrieval-health card)"
(`pipeline-health.ts:31`), and the two `PipelineLeg` doc comments asserting "only `llm` also has a
retrieval-health-card leg" (`pipeline-health.ts:130-133`, `:349-351`).

### 3f. Pulse gets a generation-health banner, and it names the reason

A second banner on Pulse home (`app/t/[team]/page.tsx`), admin-only exactly like the pipeline one, fed
by `getLlmHealth(teamId)` — the same read the retrieval card uses, so the two surfaces cannot drift.

**It renders only for `degraded`**, never for `unstable`. That is BANNERFLAP-1's rule and the reason
this whole family exists: a lone failure has already healed by the next attempt 6 times out of 10 on
this install, and a home-page banner is the loudest surface there is.

**"A specific reason" means three concrete things, because a banner that says "generation is degraded"
is the vague sentence this slice is replacing:**

1. **WHICH feature**, by name, from the task→copy map (§3b) — "Meeting summaries", not `meeting-summary`.
   Every confirmed-failing task is named, not just the newest.
2. **WHAT the model did**, from that task's own `lastError` — empty output, a timeout, a quota refusal.
   The existing reasoning-model hint (`llm-health.ts:98-100`) is per-task now, so it appears only for
   the task that actually starved.
3. **WHICH model**, per task — because they genuinely differ (`arcs` runs `teams.reasoning_model`,
   the rest the query model), and naming the wrong one sends an operator to the wrong picker.

It also states what is NOT affected when only some tasks are failing, since the complaint that opened
this family was a banner implying total breakage from a partial signal.

**Dismissal follows the pipeline banner's existing contract** (`lib/ingest/pipeline-alert.alertSignature`
keyed on the failing set), so a NEW failing task re-shows a dismissed banner and a healed one does not.
Reusing that helper rather than inventing a second dismissal scheme is deliberate: it already encodes
"you cannot permanently hide a broken thing".

### 3e. The arcs API is the OTHER `getLlmHealth` consumer, and widening makes it lie

`app/api/brain/arcs/route.ts:85-95` reads `getLlmHealth` and maps `llm.state === "degraded"` to
`reason: "model_failing"`, embedding `llm.note`, as the user-facing diagnosis for an EMPTY ARCS panel.

Today that coupling is sound because every `source='llm'` row IS an arcs row. After §3a it is false: a
confirmed `meeting-summary` streak on the query model would tell a user their empty arcs are caused by
a failing model — naming meeting summaries — while the reasoning model that actually synthesises arcs
is healthy. A false diagnostic on a user-facing surface, created by this slice.

The route therefore reads the **`arcs` task's** state from `LlmHealth.tasks`, not the leg's. There are
exactly two `getLlmHealth` consumers — this route and `lib/query/retrieval-health.ts:259` — and both
are named here, because draft 2 enumerated none and that is how this was nearly missed.

## Dependencies

**Deps: BANNERFLAP-1 (merged, `c2936ba`).** §3c reuses its `failure-streak` primitives and §3d edits
the leg set of the `STREAK_SQL` consumer it shipped.

## Build-with

**Build-with tier: Fable / high effort.** Justification: it changes what an alarm SAYS, what it
WATCHES, and which surface it appears on; both error directions are expensive; and draft 1 contained
four defects that all passed its own acceptance criteria, including a headline outcome that was
skippable while every criterion stayed green. Two adversarial review rounds (Fable + Codex) per the
repo's adversarial-build loop, plus the cold spec reads that produced this draft.

## Tier safety

No tier surface changes. `recordLlmOutcome` writes `team_id`-scoped rows through the existing single
writer (`lib/ingest/runs.recordIngestRun`); this slice adds callers, not a writer or a table. The read
stays `where source = 'llm' and team_id = $1`. Removing `llm` from the pipeline banner NARROWS what a
team-scoped surface displays. No new API route, no schema change, no change to
`visibleItems`/`visibleTasks`/`visibleGroupIds`. `meta.task` is a fixed developer literal, never user
content.

## 4. Acceptance criteria

- `test/datamechanics/llm-health-per-task.datamechanics.test.ts` — real Postgres, entered at a PRODUCTION path (`refreshMeetingArtifacts` / the meeting-upload action), not the extraction helper: a failed summary pass writes a `source='llm'` row with `meta.task = "meeting-summary"`. Entering at the helper would pass for a builder who threaded `record` only where the test passes it, leaving every real caller unobserved — review's "pin the call site, not the function" point, and how draft 1 could have shipped.
- `test/llm-health.test.ts` — a FAILED summary pass followed by a SUCCEEDING action-items pass leaves the leg degraded once the summary streak confirms. Under draft 2's shared task string the leg read `healthy` — action items runs last, so the task's newest row was always `ok` — while every meeting summary was blank. This is the criterion that pins the split.
- `test/llm-health.test.ts` — with ZERO participating tasks (rows exist, all older than `TASK_RECENCY_MS`) the leg is `unknown`, not `healthy` and not `degraded`.
- `test/generation-health-banner.test.ts` — a new Pulse banner to build: `getLlmHealth`'s `degraded` state, and only that state, produces it; it names every confirmed-failing task through the copy map with that task's own model and error; it states what is unaffected when only some tasks fail; and it reuses `alertSignature` for dismissal so a newly-failing task re-shows a previously dismissed one.
- `test/arcs-route-llm-diagnosis.test.ts` — the empty-arcs diagnosis reads the `arcs` TASK's state, so a confirmed `meeting-summary` failure beside a healthy `arcs` does NOT tell a user their arcs are empty because the model is failing.
- `test/llm-health.test.ts` — the leg's state is the WORST across participating tasks: `degraded` when any task has a confirmed streak even though another task is healthy, `unstable` for a lone failure, `healthy` when every participating task's newest run succeeded.
- `test/llm-health.test.ts` — a failure of task A followed by a success of task B does NOT clear A's streak — the masking §1 refuted for today's data and §3a re-arms.
- `test/llm-health.test.ts` — a task whose newest run is older than `TASK_RECENCY_MS` is EXCLUDED from the verdict, so two ancient failures cannot pin the leg degraded forever; and a task inside the window is included.
- `test/llm-health.test.ts` — `lastModel`/`lastError`/`lastFailedAt` come from the newest FAILING row across tasks, not the leg's newest row: with a fresh `arcs` success beside a confirmed `meeting-summary` failure, the fields must describe meeting-summary. And `tasks[]` carries a per-task model, so a two-task outage is not fronted by one model's name.
- `test/llm-health.test.ts` — the note resolves a task slug through the copy map, names EVERY confirmed-failing task when there is more than one, and falls back to a readable phrase for an unmapped slug rather than printing a bare literal.
- `test/pipeline-health-llm-leg.test.ts` — `getPipelineHealth` does NOT include `llm` in `legs` or `failing`, so a generation failure cannot paint "the brain isn't getting fresh data"; and the graph/connector legs are unaffected by the exclusion.
- `test/guards/llm-record-coverage.test.ts` — a build-failing guard: every `completeText`/`completeTextOrNull` call site in `lib/` either passes `record:` or appears in an explicit commented exemption list. It must resolve `lib/social/llm.ts`'s **re-export** of `completeText`, or it is vacuous over exactly the deferred site.
- `test/datamechanics/llm-health-per-task.datamechanics.test.ts` — real Postgres: the per-task read partitions by `meta->>'task'` (a jsonb expression the unit tier cannot exercise), stays team-scoped, and breaks a same-millisecond `finished_at` tie by `id desc`.
- `docs/ARCHITECTURE.md` — the `ingest_runs` row records that `source='llm'` is opt-in per call site, which tasks record today, that the leg's state is the worst across tasks within the recency window, and that `llm` is no longer a pipeline-banner leg.

## 5. Scope

**In:** `record:` at the enumerated low-volume call sites (§3a); the Pulse generation-health banner
(§3f); the arcs-route diagnosis fix (§3e); per-task streaks with the
recency bound (§3c); the note deriving task, model and copy from the failing task (§3b); removing
`llm` from the pipeline banner (§3d); the coverage guard; the `docs/ARCHITECTURE.md` row.

**Deferred, each with its reason:**

- **The fan-out call sites — `lib/dashboard/timeline-summary.ts` and `lib/dashboard/doc-task-infer-run.ts`.**
  Measured: timeline-summary is **37.9 model calls/day** (one per person-day, re-run on every
  background rebuild) against 333.7 total `ingest_runs` rows/day and a 50-row runs panel. Recording
  per call would make the operator's panel mostly timeline summaries. The right answer is one row per
  PASS rather than per call — an aggregation `recordLlmOutcome` does not currently do — which is a
  change to the recording primitive, not to a call site. Named as the next slice.
- **`lib/social/generate.ts`** — it reaches `completeText` through `lib/social/llm.ts`'s re-export,
  and whether social generation belongs on the *answering-model* leg is a product question. The
  coverage guard lists it explicitly so the gap is enumerated, not invisible.
- ~~Surfacing generation health on Pulse~~ — **no longer deferred.** The owner decided it should say
  so with a specific reason; it is §3f and ships in this slice.
- **`arcs` as a pipeline-banner leg.** Same question as §3d, different source; one at a time.
- **Embeddings / reranker.** A different model class with its own config and its own probe
  (`retrieval-health`'s dense leg), deliberately outside `source='llm'`.
- **Per-task legs on the card.** One row with a worst-of state; a row per task would grow the card
  with every feature.

## 6. What would falsify this

Wrong if the leg still reports healthy while a user-visible generation feature is failing. The shape
to check: a recorded task failing repeatedly while the leg stays green — which would mean the per-task
partition is not partitioning, and the data-mechanics criterion is the guard against it.

Wrong in the other direction if the leg becomes noisy. Two bounds exist: BANNERFLAP-1's confirmation
threshold (a lone failure never goes loud — measured, which is why widening is safe to do now rather
than before it landed) and §3c's recency window. If prod shows a LIVE task aging out of the window,
the window is too tight and the response is to widen it, not to remove it.

The §1 refutation is itself falsifiable: if prod later shows a `source='llm'` failure followed by a
different task's success, the masking is live — and §3c's per-task partition is what makes that
observation harmless instead of a regression.

And §3d is falsifiable by its own cost: if an answering-model outage goes unnoticed because it left
the loud banner, the retrieval-health card is not a sufficient home and Pulse needs the generation
surface named in §5.
