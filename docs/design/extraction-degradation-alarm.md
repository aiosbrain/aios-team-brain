# Alarm on extraction degradation

**Status:** revised after plan review — 2 blockers, both mine · **Date:** 2026-08-03 · **Owner:** Chetan
· **Task:** AIO-693 (`COST3`)

## The problem

On 2026-07-30 the extraction model was changed to one 10x cheaper per call. It passed the only
save-time check we have (`checkStructuredOutputSupport`, #442) because it genuinely does support
structured outputs — it just resolves entity identity badly. Work per episode climbed while **total
spend fell** (episode volume dropped faster), so every headline number moved the right way.

Nobody was told for four days. It was found because someone asked why the bill looked odd.

Prod's extraction model is now cleared (`teams.extraction_model IS NULL` → answering, `qwen3.7-max`,
reasoning off), verified live through the proxy on 2026-08-03. So this is about the next time.

## What plan review corrected (both were load-bearing, both were mine)

### 1. The probe I planned to extend is NOT scheduled

I wrote that extraction-health "already runs on a schedule". It does not. `getGraphExtractionHealth`
has exactly two callers and both are **page renders** (`lib/ingest/pipeline-health.ts:158` →
the dashboard home and the admin integrations page). The file's own header says it must not break
"a page render".

So the design as written delivered exactly as poorly as the Costs-page panel I dismissed as "a *pull*
surface — it waits for a human to visit". It would have reproduced the incident verbatim: four days of
nobody opening the page.

**The repo already has the right mechanism and I didn't know it.** `lib/query/retrieval-alert.ts` sends
an **edge-triggered, debounced admin email** — fires only on the ok→degraded transition, with a
symmetric recovery mail — driven from the scheduler tick (`lib/ingest/scheduler.ts:52-81`). That is
what makes "nobody was told" impossible, and it is the shape this must copy.

### 2. "Non-zero duplicate facts is suspicious" was already disproven, in this codebase

I proposed alarming on the presence of `IS_DUPLICATE_OF` edges. `lib/graph/learning.ts:24-36` —
written **2026-07-20, ten days before the bad model** — measured **~26% of the graph** as exactly those
edges on a healthy extractor, and filters them out of every read as "bookkeeping, never knowledge".

My own sampling (35% before the switch → 70% after) corroborates that baseline rather than
contradicting it. Which means the number I reported as a discovery was documented in the repo the whole
time, and one grep would have found it. Same failure as [[grep-before-claiming-every-other]], in the
spec written to prevent a different failure.

**Consequence for the design:** an absolute threshold is unusable. Graphiti emits these edges as normal
dedupe bookkeeping. Only a **rate change against a rolling baseline** is signal.

## Proposal (Signal 1 cut — see below)

One signal, delivered on the scheduler tick.

### The predicate

Dedupe-edge share of recent extraction output:

```cypher
MATCH ()-[r:RELATES_TO]->()
WHERE r.created_at >= $since
RETURN count(r) AS total,
       count(CASE WHEN r.name = 'IS_DUPLICATE_OF' THEN 1 END) AS dedupe
```

`r.created_at` is extraction time, deliberately distinct from the backdated `valid_at`
(`extraction-health.ts:107-117`), so a time-bounded slice means "what the extractor did recently".

**Cost:** one aggregate over `RELATES_TO`, the same query class as the two full-edge scans
`getGraphExtractionHealth` already runs concurrently per admin render. Tens of milliseconds at ~31k
facts. (My first draft cited a `LIMIT` as the mitigation — that is a no-op on an aggregate, which
returns one row regardless.)

### The threshold, measured not guessed

Fire when the recent dedupe share exceeds the **trailing baseline** by a margin, with a floor:

- **Baseline:** the same ratio over an older window, so the comparison is self-calibrating per install.
  A team whose corpus naturally produces more dedupe edges is not permanently accused.
- **Minimum denominator**, mirroring `MIN_EPISODES_FOR_EXTRACTION_SIGNAL = 25` — 1 dedupe edge out of 3
  on a fresh install is 33% and means nothing.
- Measured reference points: ~26% (healthy, 2026-07-20, from `learning.ts`), ~35% (my sample,
  pre-07-30), ~70% (during the bad model). The margin is set from those and its provenance goes in a
  comment beside the constant.

### Delivery

Scheduler tick → edge-triggered admin email, copying `alertDenseDegraded`'s debounce exactly (fire on
the transition only, never on every tick), plus the reason on the existing admin card.

### Signal 1 (calls-per-episode) is CUT from this task

It was going to reuse `getGraphEfficiency` from #471. Review found the reuse is not "one import":

- It returns `EMPTY` unless `viewer.isAdmin`, and a probe has no viewer — using it means fabricating an
  admin, deliberately bypassing a gate whose stated purpose is that no caller decides it.
- `degrading` is `!truncated && …`, and truncation binds first **in exactly the degraded regime the
  alarm exists to catch**. Reused as an alarm that inverts: maximum damage → silence.
- It only exists on the unmerged `feat/calls-per-episode` branch.

It adds little over the dedupe signal, which is cheaper, more specific, and fires on the same incident.
Separate task if wanted, after #471 merges.

## Contract change, named because it spans two consumers

`GraphExtractionHealth` is `{stalled, reason}` and pipeline-health synthesizes ONE failing leg keyed on
`extraction?.stalled` (`pipeline-health.ts:188-196`), while `retrieval-health.ts` re-assembles from the
pure fns with a single `extractionStalled` boolean. A second degraded cause touches the interface and
both assemblies — the probe's own header warns that two assemblies of one number is how surfaces drift.

## What this deliberately does NOT do

- **No auto-revert.** It tells; the human decides.
- **No save-time block.** Entity-resolution quality is a property of the model's judgment on *your*
  corpus; no catalogue exposes it and a curated allowlist would be false confidence on someone else's
  corpus.
- **No cleanup.** Removing existing duplicates needs the re-projection tool `project.ts:96-100` says was
  never built, and the naive shortcut re-pushes duplicates under the same names. Separate task.

## Risks

| Risk | Mitigation |
|---|---|
| Threshold cries wolf and the alarm gets ignored | Relative to a trailing baseline, not absolute; minimum denominator; provenance comment |
| Multi-team instance misattributes | The model is per-team (`teams.extraction_model`) but every Neo4j count is global — a bad pick by team A degrades team B's card. Stated, matching the probe's existing documented scope asymmetry |
| Graphiti renames the relation | Pin `IS_DUPLICATE_OF` and real prod fact strings in a unit test — otherwise a version bump silently zeroes the count and the signal dies quietly |
| Neo4j unreachable | Unknown reads as unknown, never degraded — matches the existing contract |
| Email fatigue | Edge-debounced like `alertDenseDegraded`; one mail per transition |

## How we will know it worked

The damage from 07-30→08-02 is still in prod. **Date-pin the acceptance run to that `created_at`
range** — otherwise, once those edges age out of the recency window, the test passes by never being
runnable.

## Guards worth building (CLAUDE.md §7)

1. The predicate pinned against **real prod fact strings and the real `r.name`** — a Graphiti bump that
   renames the relation must fail the build, not silently disarm the alarm.
2. Unknown / empty-graph / below-floor cases assert **not degraded** — the cry-wolf contract.
3. If the email ships: a debounce test (one mail per transition).

Skipped as ceremony: a drift guard over the measured threshold (unmachineable; a provenance comment is
the honest artefact), and a CI fixture replaying the damage window seeded from the threshold constant —
that is the mutation-testing trap this repo has already recorded.
