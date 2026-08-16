# Small-model activation for graph refinement calls (GRAPHSMALL-1)

Status: **reviewed (cold read) and folded — READY to build against** · Owner: chetan
· Tier build-with: unit (routing + decision function) + script/battery (the measured A/B)

**Review:** cold-read by **Codex gpt-5.5** — verdict *needs revision*, 1 BLOCKER + 2 HIGH + 2 MEDIUM
+ 1 LOW, all confirmed and folded below (the Q1/Q2 control clause, the dead-Q3 metric set, arm-config
isolation, the summary metric's boilerplate blind spot, and the fixed 15% threshold). A **Fable** cold read was
attempted first and **stalled without producing a verdict** — it is not counted as a review.

**Deps:** none blocking. Coordinates with **EXMODEL-1** (in progress — qualifying an extraction model
at save time with a real Graphiti-shaped probe); this spec CONSUMES that probe for model selection
rather than re-implementing it, and must not land a second qualification path.

**Increment:** ONE PR = the battery arm + the two missing quality metrics + the pre-registered
decision function + RUNBOOK. Explicitly NOT the prod config change (a human action after readout) and
NOT PIPEFF-5.

## Problem

`GRAPHCOST-7` (#488, DONE) built small-model routing: Graphiti asks for a cheap model on the calls it
marks `ModelSize.small`, the proxy honours the marker (`wantsSmallModel` →
`selectSmallExtractionBackend`), and `SMALL_ELIGIBLE_KINDS` (`lib/llm/graph-call-kind.ts`) names them.

**The lever was never pulled.** `teams.extraction_small_model` is unset, so
`selectSmallExtractionBackend` returns `null`, `smallTarget` is `null`, and
`app/api/internal/llm/v1/chat/completions/route.ts` falls to `strong` for every call. All graph traffic
runs on `qwen/qwen3.7-plus`.

## Measured current state

Window **2026-08-05 → 08-16** — the clean post-instrumentation window. Any window crossing **08-04** is
contaminated: `call_kind` only began populating then, and the pre-instrumentation rows read as
"unlabelled" (08-03 alone carries $43.52, which is enough to invert conclusions).

- Graph = **$18.35 / 12d (~$46/mo)**, 14,851 calls, 2,187 chunk-episodes → 6.8 calls/episode.
- **48.9M input vs 2.2M output tokens** — this is an INPUT problem; a lever that does not cut input
  tokens is not a cost lever.

| small-eligible kind | calls | avg in | USD | share |
|---|---|---|---|---|
| `dedupe_edges` | 8,555 | 1,089 | $3.17 | 17.3% |
| `node_summaries_batch` | 810 | 5,944 | $1.83 | 10.0% |
| `edge_timestamps` | 1,269 | 549 | $0.27 | 1.4% |
| **addressable** | **10,634 (72% of calls)** | | **$5.27** | **28.7%** |

### OPEN RISK: is `node_summaries_batch` actually marked small? (28.7% vs 18.7%)

`SMALL_ELIGIBLE_KINDS` lists `node_summaries_batch` and `edge_timestamps` on the strength of a **code
comment** ("0.29.3 marks these `ModelSize.small` too"), not on anything observable in prod. It cannot
be confirmed from `llm_usage`: the marker lives in the REQUEST body, `smallTarget` is null today so
everything routes strong regardless, and we store the resolved model, not the requested one.

This is not academic — **`node_summaries_batch` is $1.83, 10.0% of graph spend.** If the deployed image
does not actually mark it small, the addressable prize is **18.7%, not 28.7%**, and the 15% SHIP
threshold below goes from comfortable to nearly unreachable.

**Settle it for free, before spending anything.** The capture tap
(`scripts/graph-window-battery/capture-tap.mjs`) already records request bodies to JSONL. A projection
replay with the tap on — RUNBOOK steps before the paid step — shows exactly which `call_kind`s carry
`GRAPHITI_SMALL_MODEL_MARKER`. That is a zero-cost, empirical answer to a question the spec would
otherwise be resting on a comment for, and it gates whether the battery is worth running at all.

(That the 0.29.3 upgrade IS deployed is already settled empirically: `node_summaries_batch` has 810
calls and exists only in 0.29.3, while 0.13.2's `node_attributes` has 0.)

### Two corrections this spec exists to carry forward

1. **GRAPHCOST-7's "65% of graph spend" is STALE — do not reuse it.** It was measured on graphiti
   0.13.2, where the per-entity `node_attributes` fan-out dominated. The 0.29.3 upgrade (GRAPHCOST-8)
   replaced that with batched `node_summaries_batch`; `node_attributes` is **0 calls** today. The prize
   is **28.7%, not 65%** — a 2.2× overestimate for anyone reading the old row.
2. **GRAPHCOST-7's quality claim is true but NARROWER than it reads.** "Cannot degrade extraction
   quality" holds — these kinds never touch entity/edge extraction. But `dedupe_edges` governs
   **duplicate-fact** quality and `node_summaries_batch` governs **summary** quality, and neither is
   extraction. Activation is therefore gated on a battery, not on that sentence.

## What can actually degrade, per kind

| downgraded kind | what it decides | metric that sees it |
|---|---|---|
| `dedupe_edges` | whether two facts are the same fact | **Q7** name-universe convergence + **Q1**'s upper bound |
| `node_summaries_batch` | entity summary text | **none — gap, Q10 below** |
| `edge_timestamps` | a fact's temporal bounds | **none — gap, Q11 below** |

**NOT `Q3`.** An earlier draft made Q3 (IS_DUPLICATE_OF share) the primary dedupe gate. Q3 was
**REMOVED by Amendment 2** of the parent spec: graphiti 0.29.3's `add_episode` discards
`duplicate_pairs` and never writes the relation, so Q3 reads a **structural zero on every arm**
(`scripts/graph-window-battery/decision.mjs:81-84`). Specifying it would have gated the slice's single
biggest risk on a metric that cannot move. Its fragmentation duty now lives in **Q7** and **Q1's upper
bound** — which is also why Q1 cannot be repurposed as a control (below).

### Why Q1/Q2 are NOT controls (corrected after review)

An earlier draft claimed Q1/Q2 "cannot move, so movement means the harness is invalid." **That is
wrong, and it would have discarded the most likely true finding as a harness fault.**

Q1 and Q2 are measured from **final `Entity` nodes — post-dedupe canonical nodes**
(`scripts/graph-window-battery/measure.ts:45,83,143`), not from raw extractor output. Extraction being
untouched does NOT hold the final entity set fixed, and there is a concrete path from a downgraded
kind to Q1: `node_summaries_batch` writes the summaries that `dedupe_nodes` (strong, untouched) READS
when deciding whether two candidate entities are the same. Worse summaries ⇒ worse merge decisions ⇒
`Chetan` / `Chetan Nandakumar` / `Chetan N.` survive as separate nodes ⇒ Q1 rises and Q2/Q7 shift.
That is a **genuine quality regression, and precisely the one this battery exists to catch** — the
control clause would have relabelled it "invalid harness" and thrown the finding away.

So Q1/Q2 keep their existing status as **judged quality metrics with the parent spec's bands**
(Q1 is already the documented catch-all for fragmentation, `decision.mjs:61`).

## Coordination constraints found while building (both are real, both from reading)

1. **`Q8` and `Q9` were ALREADY TAKEN — these metrics are `Q10`/`Q11`.** `scripts/graph-window-battery/q8-orphan-drop.mjs`
   defines `Q8′` (orphan-drop loss rate) with its own test file. Shipping a second `Q8` would have put
   two different meanings on one label in one battery — the renaming is not cosmetic.
2. **PIPEFF-5 is ALREADY BUILT AND PAUSED on `origin/feat/graph-combined-extraction`**, and it touches
   the paused branch's battery files (`build-arms.mjs`, `capture-tap.mjs`, `corpus.mjs`, `count-chunks.ts`, `seed-local.mjs`, all under `scripts/graph-window-battery/`) plus
   `run-rep.sh`. This slice therefore **must not edit those files**: the arm-config mechanism and the
   marker pre-flight land in NEW files instead of as edits to `seed-local.mjs` / `capture-tap.mjs`.
   Verified conflict-free: that branch does not touch `scripts/graph-window-battery/measure.ts`,
   `scripts/graph-window-battery/decision.mjs`, `scripts/graph-window-battery/judge.mjs`, or
   `scripts/graph-window-battery/RUNBOOK.md`, which are the files this slice changes.

## Design

Reuse `scripts/graph-window-battery/` wholesale — its topology and capture tap
(`scripts/graph-window-battery/capture-tap.mjs`), the readout
(`scripts/graph-window-battery/measure.ts`), the judge (`scripts/graph-window-battery/judge.mjs` +
`scripts/graph-window-battery/decision.mjs`), and the cost harness (`scripts/graph-ingest-cost.mjs`).
Two deltas:

1. **The arms differ by team CONFIG, not by a bind-mounted graphiti patch.** `STRONG` =
   `extraction_small_model` unset (today's behaviour); `SMALL` = it set to the chosen model. Same
   image, same corpus, same everything else.

   **This must be a MECHANISM, not a claim** (review, HIGH). The bind-mount design is checkable with
   `diff`; a config field is not, and `scripts/graph-window-battery/seed-local.mjs:93` copies the whole
   `teams` row into a battery DB that sequential arm runs SHARE. The concrete failure: `STRONG` runs
   after `SMALL` without the field being cleared, both arms route small, the delta collapses, and the
   run reads as "no savings / quality equal" when in truth arm separation was broken. So:
   - the arm's config is **set explicitly at the start of each arm run**, not inherited from whatever
     the previous arm left behind;
   - each arm **snapshots the effective config** (the resolved small-backend target, i.e. what
     `selectSmallExtractionBackend` actually returns) into its result JSON;
   - the judge **refuses to compare two arms whose snapshots are identical**, since an experiment
     whose arms did not differ cannot report a difference;
   - the snapshot diff must be exactly the one field — asserted structurally, so "arms differ in
     exactly one config field" is checked rather than asserted in prose.
2. **Two new quality metrics for the gaps above**, because shipping without them would test the one
   kind that already has coverage and wave through the two that don't:
   - **Q10 summary health** — over `(:Entity).summary`. Named "health", not "informativeness":
     review was right that non-empty share + mean length is a **weak structural** check that catches
     blank / truncated / padded output but **passes same-length boilerplate** ("This entity is
     mentioned in the source material." for every entity, at incumbent-like length). So Q10 carries a
     third, discriminating term: **distinctness** — the share of summaries that are near-duplicates of
     each other (normalised), plus token overlap against the entity's own adjacent
     `RELATES_TO.fact` text. Boilerplate is by construction self-similar and detached from the entity's
     facts; that is what makes it detectable when length cannot see it.
   - **Q11 temporal coverage** — the share of `RELATES_TO` edges carrying a resolved `valid_at`. Only
     meaningful as a ratio to STRONG, since the extractor sets many dates itself and
     `edge_timestamps` fires only for the ones it left unset.

**Cost is MEASURED, not modelled.** The tap forwards to the real `/api/internal/llm/v1/*`, so
`llm_usage` rows come from the production metering path and the savings number is an observation. A
modelled "N× cheaper" estimate is not acceptable evidence here.

**Model selection is a probe, not a price-list pick.** EXMODEL-1 found candidates that 400 outright or
collapse to 1–3 entities *while advertising structured outputs*. The chosen small model must clear that
probe before it enters an arm; a model that fails the probe is not a battery result, it is a
misconfiguration.

## Decision function — pre-registered, before any number exists

Inherits `docs/design/graph-episode-window.md`'s conventions (2 reps/arm, mean for band metrics,
STRONG's own spread as the noise estimate, symmetric bands, validity ceiling in band units). Additions:

### AMENDMENT (during build): `C1` is the wrong cost gate for this arm — add `C2`

Found while reading `scripts/graph-window-battery/decision.mjs` to implement against it, not from a
review. **`C1` is `input tokens / episode` with `kind: "ratio-fall", margin: 0.25` — it REQUIRES the
arm to send 25% fewer input tokens.** The window levers it was written for did exactly that (they
carried fewer prior episodes). **This lever does not reduce tokens at all** — the same bytes are sent,
to a cheaper model. C1 would therefore FAIL the small-model arm categorically, for a saving the lever
cannot by construction produce, and a spec that shipped with C1 as its cost gate would have
pre-registered its own guaranteed STOP.

So for this arm:
- **`C2` = measured USD per episode, `kind: "ratio-fall"`** — the thing that must actually improve.
  `scripts/graph-ingest-cost.mjs:171` already emits `usdPerEpisode` in the same summary object the
  judge reads `inputTokensPerEpisode` from (`scripts/graph-window-battery/judge.mjs:111`), so this is
  a new registry entry over data that already exists, not a new measurement path.
- **`C1` becomes DIAGNOSTIC for this arm, not a ship gate.** Input tokens/episode should stay roughly
  FLAT here; a large move means something changed that this lever does not touch, and is worth reading
  even though it cannot pass a `ratio-fall`.

- **The metric set is the judge's CURRENT one — `Q1`, `Q2`, `Q4`, `Q5`, `Q7` — plus `Q10`/`Q11` and the
  new `C2`, with `C1` diagnostic.**
  Not Q3 (removed, structural zero on 0.29.3) and not Q6 (superseded by Q7). Taking the set from
  `scripts/graph-window-battery/measure.ts`'s header comment instead of from
  `scripts/graph-window-battery/decision.mjs` is how the
  first draft specified two metrics that cannot move; the judge is the source of truth, not the
  readout's docstring.
- **No control clause.** Q1/Q2 are judged on the parent spec's existing bands (see above for why
  treating them as controls would discard a real regression as a harness fault).
- **ARM-SEPARATION GATE (replaces the control clause as the validity check):** if the two arms'
  effective-config snapshots are identical, the run is **INVALID** — the arms did not differ, so no
  difference can be reported. This is a validity check the experiment genuinely supports, unlike the
  one it replaces.
- **SHIP** iff: every band metric within band, arm separation confirmed, and **`C2` (measured USD per
  episode) falls by ≥ the threshold set by the pre-flight** — 15% when the marker pre-flight confirms the full 28.7%
  addressable set, but **10% if the pre-flight shows only 18.7%** (i.e. `node_summaries_batch` is not
  marked small). Review's LOW is right: a flat 15% against an 18.7% ceiling demands ~80% realisation
  and would force STOP on a clean run that captured most of the reachable saving. **The threshold is
  fixed by the pre-flight, which runs BEFORE any arm — so it is still pre-registered, not chosen after
  the numbers.**
- **STOP** iff any band metric fails outside noise. A pass "within noise but below band" resolves the
  same way the parent spec resolves it — symmetrically — so the joint cannot be chosen after the fact.

## Scope

**In this PR:**
- A `SMALL` arm on the existing battery, differing from `STRONG` by exactly one team config field.
- Two new quality metrics — **Q10** summary health, **Q11** temporal coverage — in
  `scripts/graph-window-battery/measure.ts`, covering the two downgraded kinds that have no coverage.
- The CONTROL clause + SHIP/STOP thresholds in `scripts/graph-window-battery/judge.mjs` /
  `scripts/graph-window-battery/decision.mjs`, pre-registered before any number exists.
- The per-`call_kind` cost split in the battery readout, so savings are measured.
- `scripts/graph-window-battery/RUNBOOK.md` updated with the arm and its config step.

**Cut, deliberately:**
- **Turning it on in prod.** Setting `teams.extraction_small_model` is a human config action taken
  AFTER the battery reads out; this PR must not change live team config.
- **Running the battery.** Authoring the arm is free; step 5 of the RUNBOOK is the only step that
  spends, and spending is the owner's call.
- **Choosing the model.** Selection consumes EXMODEL-1's probe; this PR does not add a second
  qualification path.
- **PIPEFF-5** — merging `extract_nodes` + `extract_edges` ($8.46, 46.1%) is the larger lever, changes
  the extraction prompt, and needs its own battery.
- **GRAPHCOST-2** — excluding zero-payoff paths is 0.6% of spend; tracked as graph hygiene, not cost.

## Acceptance criteria

1. **unit** — `wantsSmallModel` routes exactly `SMALL_ELIGIBLE_KINDS` and nothing else: a request
   carrying the marker for a NON-eligible kind (e.g. `extract_nodes`) resolves to the strong target.
2. **unit** — `selectSmallExtractionBackend` returns `null` when `extraction_small_model` is unset,
   proving today's inert state is the one this spec describes.
3. **unit** — each arm snapshots its EFFECTIVE resolved small-backend target (what
   `selectSmallExtractionBackend` returns, not what was intended), and the two snapshots differ in
   exactly ONE field — asserted structurally, not by reading the runbook.
4. **unit** — `Q10` summary health fails a truncating arm, a padding arm, AND a same-length BOILERPLATE
   arm (identical filler text at incumbent length) — the case mean-length alone passes.
5. **unit** — `Q11` temporal coverage is expressed as a ratio to the STRONG arm, and is undefined (not
   silently 0) when STRONG produced no datable edges.
6. **unit** — the judge marks a run `INVALID` when the two arms' effective-config snapshots are
   IDENTICAL (arm separation broken, e.g. `extraction_small_model` leaked from a prior arm run), and
   does not report SHIP/STOP for that run.
7. **unit** — the judge refuses to decide on fewer than 2 reps per arm rather than judging a single rep.
8. **script** — the battery emits a per-`call_kind` cost split read from `llm_usage`, so the savings
   figure is measured through the production metering path, not modelled.
8b. **unit** — the judge gates this arm on `C2` (USD/episode) and NOT on `C1` (input tokens/episode):
   an arm that halves cost while leaving token count flat PASSES, which is precisely the shape this
   lever produces and the shape `C1`'s `ratio-fall` would have failed.
9. **docs** — `scripts/graph-window-battery/RUNBOOK.md` gains the small-model arm, and this spec is
   referenced from the ticket; no `docs/ARCHITECTURE.md` drift block changes (no new route/table/source).
10. **script** — a FREE pre-flight reports which `call_kind`s actually carry
    `GRAPHITI_SMALL_MODEL_MARKER` in captured request bodies, settling the 28.7%-vs-18.7% question
    empirically before any paid step; the battery refuses to run if the eligible set observed on the
    wire does not match `SMALL_ELIGIBLE_KINDS`, because that mismatch means the code's assumption about
    the deployed image is stale.

## What would falsify this

- The measured saving is below the pre-flight-set threshold (15% at a 28.7% ceiling, 10% at 18.7%) →
  the lever is not worth the quality risk; record the number and stop.
- The two arms' config snapshots are identical → arm separation broke; no conclusion is available.
- Q10 passes an arm whose summaries are uniform boilerplate → Q10's distinctness term is not working, and
  the summary gap is still uncovered.
- `Q7` convergence or `Q1`'s upper bound moves → dedupe changed behaviour. Q1 rising is
  fragmentation (aliases surviving as separate entities), which is the likeliest true regression here
  because `node_summaries_batch` feeds `dedupe_nodes`' input. NOT measured by Q3, which is a structural
  zero on 0.29.3.
- `Q10`/`Q11` degrade → the two kinds nobody had coverage for are exactly where it broke, which is the
  outcome this spec's extra metrics exist to be able to see at all.
- The chosen model fails EXMODEL-1's probe → not a battery result; fix the selection and re-run.
