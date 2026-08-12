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

**Judge liveness from the EPISODE NODE graphiti writes when a job finishes.**

### 3a. The two designs that were tried and rejected, and why (both by review)

**Draft 1 — "any `source='graph'` `llm_usage` row".** Refuted: `meterGraphCall`
(`lib/llm/graph-proxy.ts`) deliberately meters whatever `usage` arrives **whatever the HTTP status**,
so billed non-2xx generations stop being invisible spend (47% of the bill, measured 2026-07-30). A
truncated extraction is a **200 carrying usage**. Every failing job would have refreshed the ledger.

**Draft 2 — "a LATE-STAGE (`extract_edges`/`dedupe_edges`) ledger row".** Three defects, all verified
against the actual wheels:
- **The justification was false for the outage it cited.** On `graphiti-core==0.13.2` — the version
  running during the 2026-07 `Output length exceeded max tokens 8192` incident — `graphiti.py:396`
  reads `await semaphore_gather(resolve_extracted_nodes(...), extract_edges(...))`: they are
  **concurrent siblings**, not stages 2 and 3. The narrowing would not have caught that outage. It is
  only sequential on `0.29.3` (`graphiti.py:1131` then `:1144`), so the property was version-contingent
  and a rollback would silently remove it.
- **It moved the blind spot rather than closing it.** On 0.29.3 everything below the `extract_edges`
  call happens after the voucher fires: edge embeddings, edge resolution, attribute extraction, and —
  critically — `add_nodes_and_edges_bulk` (`graphiti.py:726`, reached via `:1170`), *the only place
  anything is written to Neo4j*. A Neo4j write failure would have read healthy forever.
- **A prompt reword re-manufactures the alarm.** `call_kind` is prefix-matched off the system prompt
  (`lib/llm/graph-call-kind.ts`), which is documented to fall to `unknown` on a graph-service upgrade.
  All-`unknown` would read as "extractor silent" → red everywhere.

### 3b. The signal

`EpisodicNode` is the right evidence, and it is better than the ledger on every axis that matters:

| property | why it holds |
|---|---|
| **End-of-job** | it is persisted by `add_nodes_and_edges_bulk` (`graphiti.py:726`), the single Neo4j write, reached only after node resolution, edge extraction, edge resolution and attribute extraction have all returned |
| **Cannot deduplicate** | a new episode is always a new node — unlike entities and edges, which resolve onto existing ones. This is exactly the property whose absence caused the false positive |
| **Not backdated** | `created_at: datetime = Field(default_factory=lambda: utc_now())` (`nodes.py:98`) — wall-clock at construction, not the episode's `reference_time` (contrast `valid_at`, which IS backdated and is why `newestFactAtMs` deliberately reads `created_at`) |
| **Version-independent** | no claim about stage ordering, no dependency on prompt text or `call_kind` |

Revised predicate — `newestEpisodicAtMs` replaces the ledger, and fact-lag stops accusing entirely:

1. **Never extracted** (`facts === 0` over the episode floor) → stall. Unchanged.
2. **Episodes are completing** — `newestEpisode − newestEpisodic <= EXTRACTION_LAG_BUDGET_MS` → **NOT
   stalled**, whatever the fact age. Dedup-frozen novelty can no longer accuse.
3. **Episodes pushed but not completing** — the same difference over budget → stall. This is the
   literal contract ("202 accepted, nothing processed") and it now covers the WHOLE pipeline including
   the Neo4j write.
4. **Either timestamp unknown** (`null`) → not stalled. Neo4j unreadable is a different leg's business.

Fact-lag becomes **observational**: still shown, never the accuser.

### 3c. The signal is REQUIRED, not optional

`ExtractionSignals.newestEpisodicAtMs` is a **required** field. Draft 2 made it optional with
"omitted ⇒ pre-fix behaviour", and that is precisely how the second call site
(`lib/query/retrieval-health.ts` — the surface that produced the bug report) stayed unwired while
every test passed. A required field makes omission a **typecheck failure**, which is the standing
"build-failing guard > discipline you have to remember" rule. A call-site guard backs it up.

## Dependencies

**Deps: none.** This slice stands alone. It reads two sources that already exist in production —
`graph_episodes` (Postgres, when WE pushed) and `Episodic` nodes in Neo4j (when graphiti FINISHED) —
and changes one pure predicate plus both of its callers. It does
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

- `test/graph-extraction-health.test.ts` — facts lagging past the budget but a FRESH episodic node (within budget of the newest episode) is **NOT** stalled — the reported false positive, and the dedup-freeze case.
- `test/graph-extraction-health.test.ts` — episodes projected but the newest episodic node older than the budget **IS** stalled — the real "202 accepted, nothing processed" outage, now covering the Neo4j write too.
- `test/graph-extraction-health.test.ts` — `facts === 0` above the episode floor is stalled **even when** the episodic node is fresh (never-extracted outranks liveness).
- `test/graph-extraction-health.test.ts` — a `null` episodic timestamp never manufactures a stall, and never suppresses the `facts === 0` case.
- `test/guards/extraction-stall-callsites.test.ts` — a build-failing guard: EVERY `deriveGraphExtractionStalled(` call site in `lib/` passes `newestEpisodicAtMs`. This exists because the second call site was missed once already.
- `docs/ARCHITECTURE.md` — the graph-extraction row states that liveness is episode-node-derived, that fact-lag is observational, and records why the two ledger designs were rejected.

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
