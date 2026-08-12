# One transient failure is not an outage — BANNERFLAP-1 / AIO-866

**Status:** spec, THIRD draft. Drafts 1 and 2 were each BLOCKED by cold review — draft 1 by Fable and
by its own prod measurement (§3a), draft 2 by Codex (§3a's safety-net hole and §3b's scope mixing).
What was rejected is recorded in place so it is not re-proposed.
**Related:** `docs/design/graph-stall-probe-liveness.md` (STALLPROBE-1 — the same "alarms must not
accuse without standing evidence" family), `docs/design/census-sample-floor.md` (CENSUSFLOOR-1, the
third member).

---

## 0. What is wrong

On 2026-08-11 a single arc-synthesis failure at **19:48Z** painted

> 🔴 **2 ingestion legs are broken — the brain isn't getting fresh data**

across Pulse and Admin. The **very next run, at 01:36Z, succeeded**. Nothing was down in between; the
banner was already stale when it was read, and it had been red for ~5h48m describing a condition that
had healed at the first retry.

Two legs, one event: the failure recorded an `ingest_runs` row for `arcs` **and** for `llm` (the
answering-model outcome), so one blip renders as two independent-looking failures — the same
"corroboration that is really one signal counted twice" shape STALLPROBE-1 fixed on the graph card.

## 1. The mechanism

Both surfaces read exactly ONE row and treat it as the verdict.

- `lib/ingest/pipeline-health.ts:217` — `failing = legs.filter((l) => (!l.ok || l.stale) && …)`, over
  `select distinct on (source) … order by source, finished_at desc`. The newest row's `ok` **is** the
  leg's state.
- `lib/query/llm-health.ts:53` — `deriveLlmState(lastRun)` returns `degraded` iff `!lastRun.ok`, over a
  `limit 1` query.

So there is no consecutive-failure threshold and no time decay, and **nothing clears the banner but a
later successful run**.

## 2. What the data says — measured, not assumed

60 days of prod `ingest_runs`, read 2026-08-12. For each failed run: did the NEXT run of that source
succeed, and how long did it take?

| leg | failures | healed on the next run | median gap to it | max gap |
|---|---:|---:|---:|---:|
| `arcs` | 3 | **3 of 3** | **5.80h** | 19.88h |
| `llm` | 10 | 6 of 10 | 3.65h | 19.88h |
| `github` | 20 | 18 of 20 | 0.53h | 0.67h |
| `dense` | 47 | 2 of 47 | 0.50h | 0.53h |
| `graph_project` | 25 | 6 of 25 | 0.46h | 1.09h |

Two things follow, and together they settle the design:

1. **Transient-and-healing is the dominant failure mode on exactly the legs that flapped the banner.**
   `arcs` healed on the next attempt every single time observed.
2. **A time-based escalation cannot work on those legs.** Their natural inter-run gap is 3.65–5.80h
   median and ~20h at the tail, so ANY grace short of ~20h escalates a healthy blip to red before its
   healing run lands — and a 20h grace is not an alarm.

And the confirmation latency a pure two-failure rule would actually deliver, measured the same way
(gap from the first failure to the second failure, where a streak occurred):

| leg | streaks observed | min | median | max |
|---|---:|---:|---:|---:|
| `dense` | 45 | 0.20h | 0.50h | 0.53h |
| `graph_project` | 19 | 0.02h | 0.51h | 1.00h |
| `llm` | 4 | 0.23h | **2.64h** | 14.42h |
| `github` | 2 | 0.50h | 0.50h | 0.50h |

A real outage goes loud in ~30 minutes on the high-cadence legs and ~2.6h median on `llm`.

## 3. The decision

A leg's failure is **confirmed** — and therefore loud — when its current unbroken failure streak is
**two runs or longer**. A streak of exactly one is **unconfirmed**: real, recorded, shown quietly, and
not in the loud banner.

| classification | when | surface |
|---|---|---|
| `ok` | newest run succeeded | green |
| `unconfirmed` | newest run failed and the run before it succeeded — **including when there is no earlier run at all** (a leg's first-ever run failing) | **quiet** — Admin → Recent ingestion runs (and, for `llm` only, its retrieval-card leg), never the loud banner |
| `confirmed` | the newest run failed and so did the one before it (streak ≥ 2) | **loud** — the banner, exactly as today |

`stale` is untouched and remains loud on its own, independently of classification: it answers a
different question ("is the poller still ticking"), it has per-source thresholds, and a leg that is
stale AND `ok` must still be loud.

### 3a. There is no time-based escalation, and that is a decision, not an omission

The first draft added one: a single failure older than a 2h grace escalated to `confirmed`. It was
wrong twice over.

- **It did not fix the motivating incident.** With a 2h grace, the 19:48Z failure goes red at 21:48Z
  and stays red until the 01:36Z recovery — 3h48m of exactly the banner §0 is about. Review caught
  the spec asserting it removed the incident while its own constant guaranteed it would not.
- **No safe value exists.** §2 shows the healing gap on the affected legs runs to ~20h, so the grace
  would have to exceed that to stop flapping, at which point it announces nothing useful.

**The escalation is also largely redundant.** For a leg with a non-null `staleThresholdMs` **that has
a scheduler heartbeat**, a failure which is never superseded means the scheduler stopped producing
rows, and `stale` already fires at that leg's own cadence + grace — loudly, today, unchanged by this
slice. The escalation would mostly have added coverage for legs whose threshold is `null`, and those
are `null` precisely because this repo has already decided their age is not judgeable (`llm`, `arcs`,
`dense`, `graph_project`, `linear_inbound`, `doc_task_infer`, `scan`, `pm_sync` — see the reasoning in
`STALE_MS_BY_SOURCE`). Adding an age judgement for them here would smuggle back in, through a
different constant, the exact thing those `null`s were written to prevent.

**"Largely", not "entirely" — the qualifier is load-bearing and was wrong in the second draft.** `stale`
ages `beatAt.get(source)`, the newest **scheduler-triggered** row, and is `false` when that clock is
`undefined` (`pipeline-health.ts:176-193`). So a source with a non-null threshold and NO scheduler row
yet is not aged at all, deliberately — `test/datamechanics/pipeline-health-poller-heartbeat.datamechanics.test.ts:79-85`
pins exactly that ("no heartbeat to judge, so no wolf-crying"). The live shape: a team runs
`meeting_notes` from `aios push` (trigger `api`), it fails, and no scheduler tick has landed for that
team yet. Today that leg is loud; under this spec it is `unconfirmed` and quiet, and `stale` will not
rescue it. Review found this; an instance-wide measurement of which sources have scheduler rows does
NOT show it, because `beatAt` is built per team.

The exposure is bounded and self-closing: the next scheduler tick for that source writes a row, which
either succeeds (leg green, correctly) or fails (streak reaches two, leg loud). So the window is one
poll cadence — 30 minutes for the sources that carry the 3h default. It is accepted rather than
patched, because the alternative is to age a leg with no heartbeat, which is the cry-wolf behaviour
that test was written to prevent. It is listed as a falsifier in §6 and pinned by its own acceptance
criterion so that it stays a deliberate cost rather than becoming an accident.

**The accepted cost, stated:** a `null`-threshold leg that fails once and is then never exercised
again stays quiet in the banner indefinitely. It is not invisible — it is `unconfirmed` on the
retrieval card and red in the runs table — but it will not shout. That is the deliberate trade: those
legs only run when there is work, so "no second run" carries no information about health, and the
standing rule in this codebase is that ignorance must not accuse.

### 3b. `failingSince` is computed from the whole streak, in SQL

The banner names the leg and its error but not the duration, which is what makes a stale red banner
indistinguishable from a live one. Worse, `components/admin/pipeline-health-banner.tsx:96` already
renders `failing since ${timeAgo(l.at)}` where `l.at` is the **newest** run — so today a leg failing
for three days is labelled "failing since 20 minutes ago".

`failingSince` is therefore the `finished_at` of the OLDEST run in the current unbroken failure
streak, and it is computed in SQL over the whole streak, not from a fixed two-row window. The first
draft specified a two-row read, which cannot express it: the graph projector 422'ing for weeks
(`pipeline-health.ts:9`) is ~144 rows at a 30m cadence, and a two-row window would report "failing for
30 minutes" about a three-day outage — the same lying-duration defect, inverted. Review caught that
the corresponding acceptance criterion was green-by-construction against a streak of exactly two.

One query per surface returns, per source: the newest run's `ok`/`errors`/`finished_at`, the length of
the current failure streak, and the streak's oldest `finished_at`. `streakLength >= 2` IS the
confirmation test, so classification and duration come from one read and cannot disagree.

**Ordering and scope, stated because the file already draws these distinctions deliberately:**

- The streak is computed over runs of **any `trigger`**, matching today's verdict read. Only the
  *staleness* clock is scheduler-only (`pipeline-health.ts:152-164`), and it stays that way. A
  scheduler-only streak would return zero rows for `llm`, whose runs are all `trigger: "api"`
  (`lib/llm/complete.ts`), and would kill the leg outright.
- Ties are broken by `id desc`, the bigserial PK — two runs can share a millisecond `finished_at`
  (a fast fail then a retry in the same tick). `llm-health.ts:73` already documents this; the pipeline
  query does **not** currently have it, so this is a new addition there rather than a preserved
  property.
- Team scoping is unchanged: `team_id = $1 or team_id is null` for pipeline legs, `team_id = $1` for
  `llm`. But the streak **partitions by `(source, team_id)`**, with the instance-wide `NULL` its own
  partition — a source-level streak would mix two different populations. This is not hypothetical:
  `access_bootstrap` writes a per-team `ok=false` row for each team that failed, plus an unconditional instance-wide heartbeat row every tick
  (`lib/ingest/scheduler.ts:258-280`), so a team's genuine failure streak would be broken by global
  heartbeat rows that say nothing about that team. The codebase has been bitten here before —
  `context_backfill_all` exists as a separate source precisely because a global row masked per-team
  rows under `distinct on` (`scheduler.ts:329-350`). Review found it.

  The leg is then classified from the partition containing the NEWEST row, which preserves today's
  "the newest row is the leg's state" semantics exactly. **Deliberately unchanged:** a global row that
  is newer than a team's failure still masks that failure, exactly as it does today under
  `distinct on`. Making a team's own streak visible through a global heartbeat is a real improvement
  and a behaviour change beyond this ticket — it is named in §5, not smuggled in here.

### 3c. `graph_extract` is exempt from classification and stays unconditionally loud

`pipeline-health.ts:205-213` appends a SYNTHETIC leg for the one failure `ingest_runs` structurally
cannot see. It has **no `ingest_runs` rows at all** and carries `at: ""`.

Run naively through the classifier it would have no streak, no timestamp (`Date.parse("")` is `NaN`),
and would therefore be permanently `unconfirmed` — **silently removed from the loud banner forever**,
with every acceptance criterion in this document still green. Review found this; it is the precise
falsification shape §6 describes, and it is the reason that section names a concrete leg instead of a
category.

It must bypass classification entirely. It is already debounced by its own detector upstream — the 6h
`EXTRACTION_LAG_BUDGET_MS`, the `MIN_EPISODES_FOR_EXTRACTION_SIGNAL` floor, the census sample floor —
so a second, weaker debounce here would be both redundant and wrong.

Its `failingSince` is **`null`**, and the banner must render the duration only when the field is
present, falling back to today's cause-only copy. Stated because the alternative is a builder
inventing one: the extraction lag boundary and the newest-episode time are both available and both
would be a fabricated "since" for a condition that is explicitly not a point-in-time failure
(`pipeline-health.ts:210`). A `null` here is the same "an admitted unknown beats a number that looks
like a measurement" rule the extraction probe already follows.

### 3d. The same classification governs `llm`, and the card must render the new state honestly

`deriveLlmState` gains `unstable` for an unconfirmed failure, distinct from `degraded`. Fixing only
`pipeline-health` would leave the retrieval card red on a healed blip; fixing only `llm-health` would
leave the banner red via the `arcs` leg. The reported symptom was two legs from one event.

Three consumers, and two need changing:

- `components/admin/retrieval-health-card.tsx:166` maps state to a dot with
  `healthy ? "healthy" : degraded ? "degraded" : "off"` — an unhandled `unstable` falls to a **grey
  "off" dot**, and line 172's fallback detail renders **"no recent activity recorded"**, which is
  false: there is recent activity, and it failed. `unstable` must render as its own quiet **amber**
  leg with copy that says a recent run failed and has not recurred. The red `note` paragraph at line
  218 stays gated on `degraded` only.
- `components/admin/pipeline-health-banner.tsx:96` must render `failingSince`, not `l.at`.
- `app/api/brain/arcs/route.ts:90` reads `llm.state === "degraded"` to explain an empty arcs payload.
  It must keep firing on `degraded` and must NOT fire on `unstable` — an unconfirmed blip is not
  grounds to tell a user their model is broken.

**Field shape for `unstable`:** `lastError` and `lastFailedAt` are set exactly as for `degraded`;
`note` is **null**, because `note` is what drives the red paragraph and an unconfirmed blip does not
earn one.

**The enforcement mechanism is the type system, not a grep.** The card's state→dot/label mapping
becomes an exhaustive `Record<LlmHealthState, …>`, so adding a member to the union is a `tsc` error at
every mapping rather than a silent fall-through to the grey "off" branch — which is exactly how
`unstable` would otherwise have rendered "no recent activity recorded" about a leg that just failed.
Review correctly pointed out that a text-matching guard cannot catch a future
`state !== "healthy"` derived boolean; a `Record` over the union can't be written incompletely at all.
The accompanying test pins the PROPERTY the types cannot express — that `unstable` maps to a
non-grey, non-"off" rendering — rather than re-asserting exhaustiveness the compiler already has.

**Known limitation, not fixed here:** source `llm` multiplexes every completion task, so a model
failing only on long prompts records failures interleaved with cheap-title successes, and the streak
never reaches two. That is a pre-existing property of the single-row read too (today the newest row is
just as likely to be an unrelated success), so this slice does not worsen it; detection rides on the
separate `arcs` leg, which records one row per failed synthesis. De-multiplexing `llm` by `meta.task`
is named in §5.

## Dependencies

**Deps: none.** Both reads are existing `ingest_runs` queries, re-expressed as a window function over
the same team-scoped rows; the classification is pure over the streak summary. It does NOT depend on
STALLPROBE-1 (merged) or CENSUSFLOOR-1 (merged), though it is the same family.

## Build-with

**Build-with tier: Fable / high effort.** Justification: it is an alarm threshold where both error
directions are expensive, and the naive version of the requested change is a DETECTION REGRESSION —
demonstrated, not hypothesised: the first draft of this spec contained two of them (the grace that
re-fires on the motivating incident, and the synthetic leg going permanently silent), and both passed
its own acceptance criteria. Two adversarial review rounds (Fable + Codex) per the repo's
adversarial-build loop, plus the cold spec read that produced this draft.

## Tier safety

No tier surface changes. Both queries keep today's scoping exactly (`team_id = $1 or team_id is null`
for pipeline legs, `team_id = $1` for `llm`); a window function over those same rows returns strictly
what `distinct on` returned plus older rows of the SAME already-scoped set. No new API route, no new
table, no change to `visibleItems`/`visibleTasks`/`visibleGroupIds`. The banner is admin-gated at its
call sites (`app/t/[team]/page.tsx:186`).

## 4. Acceptance criteria

- `test/pipeline-failure-confirmation.test.ts` — a leg whose newest run FAILED and whose previous run SUCCEEDED classifies `unconfirmed` and is ABSENT from `failing`, at any age — the reported false positive, and the case a time-based escalation would have re-broken.
- `test/pipeline-failure-confirmation.test.ts` — two consecutive failed runs classify `confirmed` and appear in `failing`, however recent.
- `test/pipeline-failure-confirmation.test.ts` — a leg whose ONLY run ever is a failure classifies `unconfirmed`, not `confirmed` — the first-run case the classification table must cover explicitly.
- `test/pipeline-failure-confirmation.test.ts` — `failingSince` is the OLDEST run of a streak of THREE OR MORE, not the second-oldest and not the newest, and is null when the leg is NOT FAILING AT ALL — note it is populated for an `unconfirmed` lone failure too, which is deliberate (a stale-and-unconfirmed leg reaching the banner should still show a real instant) and is what the implementation does. A streak of exactly two cannot distinguish oldest from second-oldest, so the fixture must be longer.
- `test/pipeline-failure-confirmation.test.ts` — a `stale` leg is loud regardless of classification, INCLUDING when its newest run succeeded — staleness is an independent signal this fix must not swallow.
- `test/pipeline-health-graph-extract-leg.test.ts` — the synthetic `graph_extract` leg (no runs, `at: ""`) is in `failing` whenever the extraction detector says so, proving it bypasses classification rather than being silently dropped, and carries `failingSince: null` rather than a fabricated instant.
- `test/pipeline-failure-confirmation.test.ts` — the streak partitions by `(source, team_id)`: an instance-wide `NULL`-team row interleaved between two team-scoped failures does NOT break that team's streak. Without this, `access_bootstrap`'s every-tick global row silently un-confirms a real per-team outage.
- `test/datamechanics/pipeline-failure-confirmation.datamechanics.test.ts` — real Postgres, the ACCEPTED COST pinned so it stays deliberate: a leg with a non-null threshold, an `api`-triggered failure, and NO scheduler row is `unconfirmed` and absent from `failing` — the shape §3a admits `stale` does not rescue. If a later change makes this loud, this test is the place that argues about it.
- `test/llm-health.test.ts` — `deriveLlmState` returns `unstable` for an unconfirmed failure, `degraded` for a confirmed one, `unknown` with no runs, and `unstable` carries a null `note` while `degraded` carries one.
- `test/guards/alarm-state-consumers.test.ts` — a build-failing guard: `unstable` renders as its own non-grey, non-"off" leg with copy that does NOT claim "no recent activity recorded". Exhaustiveness itself is enforced by `tsc` via a `Record<LlmHealthState, …>` mapping, not by this test — a text-matching guard cannot catch a future `state !== "healthy"` derived boolean, so the type system does that half and this test pins the property types cannot express.
- `test/guards/alarm-state-consumers.test.ts` — a build-failing guard: `components/admin/pipeline-health-banner.tsx` renders `failingSince`, not `at`, under its "failing since" label — the field must not ship computed-and-unread.
- `test/datamechanics/pipeline-failure-confirmation.datamechanics.test.ts` — real Postgres: the streak query returns the correct streak length and boundary under a same-millisecond `finished_at` tie (broken by `id desc`), across a source with interleaved `trigger` values, and stays team-scoped.
- `docs/ARCHITECTURE.md` — the pipeline-health row records that a leg goes loud only on a CONFIRMED failure (streak ≥ 2), that there is deliberately no time escalation and why, that `stale` and `graph_extract` are independent of it, and what stays quiet as a result.

## 5. Scope

**In:** the streak query + pure classification, its two consumers (`lib/ingest/pipeline-health`,
`lib/query/llm-health`), the `failingSince` duration AND its render in
`components/admin/pipeline-health-banner.tsx`, the `unstable` state AND its render in
`components/admin/retrieval-health-card.tsx`, the `graph_extract` exemption, the `arcs` route's
`degraded` gate, and the `docs/ARCHITECTURE.md` row.

**Tests this invalidates, named so they are changed deliberately rather than "fixed" by bending the
implementation:** `test/datamechanics/llm-health.datamechanics.test.ts` asserts a single failed run
yields `degraded`; under this spec that becomes `unstable`.

**Deferred, each with its reason:**

- **Per-source confirmation thresholds.** One rule for every leg to start. §2 shows a streak of two is
  ~30m on high-cadence legs and ~2.6h on `llm`, which is adequate for both; if prod shows a leg
  needing its own, it gets one the way `STALE_MS_BY_SOURCE` did — measured, not invented.
- **De-multiplexing `llm` by `meta.task`** (§3d's limitation). It is a real detection gap, it is
  pre-existing, and closing it means deciding whether a per-task leg is a leg — a product question.
- **De-duplicating the `llm` + `arcs` double-count.** One event still writes two rows and can still
  name two legs; this slice stops a healed blip being loud at all, which removes the observed
  instance. Collapsing correlated legs is a display question.
- **Un-masking a team's failures behind an instance-wide row.** §3b partitions the streak by
  `(source, team_id)` but still classifies from the partition holding the NEWEST row, so a global
  `access_bootstrap` heartbeat newer than a team's failure keeps masking it — exactly as today under
  `distinct on`. Fixing that changes which legs are loud, for a reason unrelated to flapping.
- **Alert email throttling.** `lib/ingest/pipeline-alert` composes the dismissal signature; whether a
  confirmed failure should also mail is untouched.
- **`ingest_runs` retention / a bounded streak window.** The streak query sorts the team's whole
  history. Measured 2026-08-12: 12,661 rows, ~299/day, nothing prunes the table, 32ms today after the
  grouped-pass rewrite (the lateral form it replaced was 44ms and O(sources × history)). Since the
  query lives inside `catch { return empty }`, the failure mode of letting this grow is a permanently
  green banner — so it needs a real answer, but the answer is retention or a window with a deliberate
  rule for legs whose newest row falls outside it, not a clamp bolted onto this slice. Review raised
  the trajectory; the quadratic factor is fixed here and the linear one is filed.
- **Any change to `stale` or `STALE_MS_BY_SOURCE`.** Different signal, different ticket — and §3a
  depends on that signal being left exactly as it is.

## 6. What would falsify this

The fix is wrong if a REAL outage goes quiet. Three concrete shapes to check, in descending order of
how badly they would bite:

1. **The synthetic `graph_extract` leg** (§3c) — it has no runs and no timestamp, so a classifier
   applied to it uniformly silences it forever. This is the one that would ship green.
2. **A `null`-`staleThresholdMs` leg that fails once and is never exercised again** — quiet by design
   (§3a). If prod shows a real outage sitting in that state for hours with no second run, the
   assumption "no second run carries no information" is wrong for that leg, and the answer is to give
   that leg a staleness threshold, not to add a global grace back.
3. **A non-null-threshold leg with an `api`-only failure and no scheduler heartbeat yet** (§3a) —
   quiet where it is loud today, until the next scheduler tick closes the window. If prod shows that
   window mattering, the answer is to give that source a heartbeat or its own rule, not a global grace.
4. **A multiplexed source whose streak never reaches two** (§3d) — `llm` is the known case.

It is also wrong in the other direction if the banner still flaps: if prod shows red banners for
failures that healed on the next attempt, then a streak of two is not enough evidence, and the next
lever is the streak length — which §2's confirmation-latency table is the baseline for.
