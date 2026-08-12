# The graph-stall probe measures novelty, not liveness — STALLPROBE-1 / AIO-876

**Status:** spec, pre-review.
**Related:** `docs/design/dedupe-alarm-0293.md` (the sibling alarm on the same card),
`docs/design/census-sample-floor.md` (CENSUSFLOOR-1 — the same "accuses without standing evidence"
class), `docs/design/graph-episode-window-phase-c.md` (PIPEFF-2, the lever that made dedupe dominant).

---

## 0. What is wrong

On 2026-08-12 the Retrieval-health card read:

> 🔴 **Graph memory — degraded** · *accepting episodes but extracting 0 facts — 2347 episodes*
> "Graph memory is reachable and **accepting episodes, but its extractor is producing no facts**
> (2347 projected · 113352 facts). Graphiti returns 202 then fails entity extraction on every job."

**Nothing was failing.** Four independent reads, all taken while the banner was red:

| Evidence | Reading |
|---|---|
| `llm_usage` (`source='graph'`) | the full pipeline — `extract_nodes` → `dedupe_nodes` → `extract_edges` → `dedupe_edges` — completed at 00:15–00:16Z, **one minute after** the newest episode was projected (00:15:02Z) |
| `llm_failures` (`source='graph'`) | **zero rows in 48h** |
| graphiti service logs | jobs accepted and drained; no traceback, no `Output length exceeded` |
| the census on the SAME card | **2,928 new entities · 13.19 entities/episode · 4 same-name splits in 1,845 names (0.2% vs a 1.5% baseline)** |

The card asserted "producing no facts" beside its own census reporting 2,928 new entities. The
quoted `Output length exceeded max tokens` is not an observed log line — it is a canned example
baked into our own `reason` string (`lib/graph/extraction-health.ts`), which reads to an operator
as a quotation from the service.

## 1. The mechanism

`deriveGraphExtractionStalled` (`lib/graph/extraction-health.ts`) declares a stall when

```
newestEpisodeAtMs − newestFactAtMs > EXTRACTION_LAG_BUDGET_MS   // 6h
```

where `newestFactAtMs` is `max(RELATES_TO.created_at)` in Neo4j.

That predicate answers **"when did the graph last learn something NEW?"** and is being read as
**"when did the extractor last RUN?"** On a mature graph those diverge:

- the graph holds ~113k facts and 2,347 projected episodes;
- `llm_usage` shows **~6.1 `dedupe_edges` calls per `extract_edges` call** — most extracted edges
  resolve onto an edge that already exists;
- a de-duplicated edge creates no new `RELATES_TO`, so `max(created_at)` does not move.

So an overnight stretch in which extraction ran correctly and found nothing genuinely new freezes
the numerator while the denominator keeps advancing → a false stall. The failure is **structural and
recurring**, not a one-off: it gets *more* likely as the graph matures, and PIPEFF-2 (narrower
extraction context) makes novel-edge discovery rarer still.

**Refuted alternative.** "0.29.3 stopped stamping `created_at`" would also freeze the clock — but the
same probe was green 23h earlier (2026-08-11 card, no graph leg), which a stamping regression dating
from the 2026-08-04 deploy cannot produce.

## 2. The blast radius is doubled

`getPipelineHealth` (`lib/ingest/pipeline-health.ts`) injects a synthetic `graph_extract` leg fed by
**the same** `extraction.stalled` boolean. One false positive therefore renders as two
independent-looking failures — the red Retrieval-health row *and* "1 ingestion leg is broken" on
Pulse — which reads as corroboration rather than as one signal counted twice.

## 3. The decision

**Judge liveness from the extractor's own ledger, not from the graph's novelty.**

`llm_usage` already records every graph LLM call with `source='graph'` and (since GRAPHCOST-5) a
`call_kind`. A successful metered call *after* the newest projected episode is direct, positive
evidence that the extractor ran on current work — it cannot be faked by deduplication, and it is a
Postgres read, so it works even when Neo4j is unreadable.

Revised predicate:

1. **Never extracted** (`facts === 0` over the episode floor) → still a stall. Unchanged; this is the
   original 2026-07 failure and novelty/liveness agree there.
2. **Extractor demonstrably ran** — ≥1 successful `source='graph'` `llm_usage` row newer than the
   newest projected episode, within the lag budget → **NOT stalled**, regardless of fact age.
3. **No recent extractor activity at all** AND facts are lagging past the budget → stall. This keeps
   the 2026-07-28 quota failure (the case the lag check was added for) loud: a dead extractor writes
   no `llm_usage` rows either.
4. **Ledger unreadable** → `null` → not stalled (fail quiet; a different leg owns reachability).

Fact-lag becomes an **observational** number on the card, alongside the existing yield line. It is
still worth showing — a graph that has genuinely learned nothing in a week is interesting — but it
must not, alone, accuse the extractor of failing.

## Dependencies

**Deps: none.** This slice stands alone. It reads two sources that already exist in production —
`llm_usage` (`source='graph'`, metered since COSTMETER-1/#437, `call_kind`-labelled since
GRAPHCOST-5/#487) and `graph_episodes` — and changes one pure predicate plus its callers. It does
NOT depend on `BANNERFLAP-1` (AIO-866) or `CENSUSFLOOR-1` (AIO-867); those are siblings in the same
"alarms must not accuse without standing evidence" family and can land in any order.

## Build-with

**Build-with tier: Fable / high effort.** Justification: the change is small in lines but it is an
ALARM predicate, where both error directions are expensive — a false positive is the defect being
fixed, and a false negative silently hides a real extraction outage (the 2026-07-28 quota failure).
It also has a fail-quiet path (`null` = unknown) that must not be conflated with "healthy". That is
exactly the fail-open/fail-closed reasoning the higher tier is for. Two adversarial review rounds
(Fable + Codex) per the repo's adversarial-build loop.

## Tier safety

No tier surface changes. Both reads are numeric health probes, deliberately NOT tier-scoped — the
existing `countGraphFacts` comment states the rule ("no content leaves the graph; 'is the extractor
producing ANY facts?' is a global question"), and the new ledger read follows it: it counts
`llm_usage` rows for the team and returns a boolean/timestamp, never row content. No new API route,
no new table, no change to `visibleItems`/`visibleTasks`/`visibleGroupIds`.

## 4. Acceptance criteria

- `test/graph-extraction-health.test.ts` — a fixture with facts lagging **past** the budget but a successful `source='graph'` ledger row newer than the newest episode is **NOT** stalled (the reported false positive).
- `test/graph-extraction-health.test.ts` — a fixture with facts lagging past the budget and **no** extractor activity since the newest episode **IS** stalled (the 2026-07-28 quota failure stays loud).
- `test/graph-extraction-health.test.ts` — `facts === 0` above the episode floor is stalled **even when** the ledger shows recent activity (never-extracted outranks liveness).
- `test/graph-extraction-health.test.ts` — an unreadable ledger (`null` activity) never manufactures a stall, and never suppresses the `facts === 0` case.
- `test/datamechanics/graph-stall-liveness.datamechanics.test.ts` — real Postgres: `extractorActivity` reads the newest SUCCESSFUL `source='graph'` `llm_usage` row for the team, returns `readable:true`+`newestAtMs:null` on an empty ledger, and never leaks another team's rows.
  - **Amended mid-build (2026-08-12).** The original criterion said "clears the stall end-to-end through `getGraphExtractionHealth`". That is NOT reachable in this tier: `getGraphExtractionHealth` early-returns `empty` when `neo4jConfigured()` is false (`lib/graph/extraction-health.ts`), and the data-mechanics tier has no Neo4j. Writing it anyway would have produced a test that passes on the early return without touching the predicate — green by construction. The end-to-end composition is covered by the pure unit tests above plus the real `extractorActivity` read here; the Neo4j half stays unverified by automation, stated rather than implied.
- `docs/ARCHITECTURE.md` — the graph-extraction health row states that liveness is ledger-derived and fact-lag is observational.

## 5. Deliberately NOT in this slice

- **The banner-flap threshold** (`BANNERFLAP-1` / AIO-866, two-consecutive-failures) — a different
  defect in a different file; batching them would make one PR unreviewable.
- **The census sample floor** (`CENSUSFLOOR-1` / AIO-867) — already specced separately.
- **The canned `Output length exceeded` example string** stays, but is reworded so it cannot read as
  a quotation from the service. Rewriting the whole reason-string taxonomy is not in scope.
- **De-duplicating the two surfaces** (one probe rendering as two failures) — the fix removes the
  false positive that made the duplication visible; collapsing the surfaces is a UI change with its
  own product question.

## 6. What would falsify this

If, after the change, a genuinely dead extractor (provider 429, container wedged) failed to raise the
stall within the lag budget, the ledger-liveness predicate would be too permissive — the signal it
trusts (`llm_usage` rows) would have to be produced by something other than a real extraction. The
data-mechanics criterion above is the guard against exactly that inversion.
