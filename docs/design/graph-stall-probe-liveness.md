# The graph-stall probe measures novelty, not liveness — STALLPROBE-1 / AIO-876

**Status:** spec — third design of this slice. Drafts 1 and 2 (both LLM-ledger based) were killed by
review; §3a records why, so they are not re-proposed.
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
- `llm_usage` shows **6.6 `dedupe_edges` calls per `extract_edges` call** — most extracted edges
  resolve onto an edge that already exists. Re-measured against prod 2026-08-12 rather than quoted:
  8,919/1,340 over 30d = 6.66, 4,232/642 over 7d = 6.59, 510/68 over 2d = 7.50. (Earlier drafts of
  this doc said "~6.1" and the ticket said "~8.5"; neither reproduced. The argument only needs the
  ratio to be ≫1, but a cited number that does not reproduce is its own defect.);
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
| **End-of-job** | it is persisted by `add_nodes_and_edges_bulk` (`graphiti.py:726`, reached via `:1170`) — the single Neo4j write **on the path we run** (`/messages` → `add_episode`, no saga, `update_communities=False`); 0.29.3 does write more after it when a saga is passed (`:736-780`) or communities are enabled (`:1184`), neither of which the REST server does. It is reached only after node resolution, edge extraction, edge resolution and attribute extraction have all returned, and the node's EXISTENCE is the completion evidence. The bulk write is ONE managed transaction (`utils/bulk_utils.py:136-146`, `session.execute_write`), so a mid-write Neo4j failure rolls the episode node back with it — "covers the write itself" holds rather than being asserted |
| **Cannot deduplicate** | a new episode is always a new node — unlike entities and edges, which resolve onto existing ones. This is exactly the property whose absence caused the false positive. Our projector POSTs `/messages` with no uuid, so `EpisodicNode.get_by_uuid` (`:1099`) is never taken and a fresh node is constructed every time |
| **Not backdated** | wall-clock, not the episode's `reference_time` (contrast `valid_at`, which IS backdated and is why `newestFactAtMs` deliberately reads `created_at`) |
| **Version-independent** | no claim about stage ordering, no dependency on prompt text or `call_kind` |

Two things about that timestamp are stated rather than glossed, both verified against the pinned
0.29.3 wheel:

- **`created_at` is the job's START, not its finish.** `now = utc_now()` is taken at the top of
  `add_episode` (`:1068`) and handed to the constructor (`:1109`); it is never restamped. So the
  measured lag overstates by at most one job's duration (seconds to a couple of minutes) against a
  6h budget — in the **accusing** direction, never the suppressing one. It is written down because a
  budget later tightened toward job duration would make it load-bearing.
- **`add_episode_bulk` (`:1230`) would weaken this signal**, because it saves its episode nodes
  BEFORE extraction (`:1336`, `# Save all episodes`) — an episode node would then exist even when
  extraction failed outright, i.e. exactly the "202 accepted" semantic being replaced. We do not use
  it (the projector is fire-and-forget `/messages` → singular `add_episode`), and nothing in this repo
  can detect a graph-service switch to it, so the limitation is recorded at the source and in
  `docs/ARCHITECTURE.md` instead of being guarded. (`add_triplet` at `:1645` builds a throwaway
  `EpisodicNode` (the literal is at `:1745`) but passes `[]` as the episodic nodes to the bulk write,
  so it never persists one.)

Revised predicate — `newestEpisodicAtMs` replaces the ledger, and fact-lag stops accusing entirely:

1. **Never extracted** (`facts === 0` over the episode floor) → stall. Unchanged.
2. **Episodes are completing** — `newestEpisode − newestEpisodic <= EXTRACTION_LAG_BUDGET_MS` → **NOT
   stalled**, whatever the fact age. Dedup-frozen novelty can no longer accuse.
3. **Episodes pushed but not completing** — the same difference over budget → stall. This is the
   literal contract ("202 accepted, nothing processed") and it now covers the WHOLE pipeline including
   the Neo4j write.
4. **Either timestamp unknown** (`null`) → not stalled. Neo4j unreadable is a different leg's business.

Fact-lag becomes **observational**: still shown — as a quiet line on the card, never a leg state —
but never the accuser. "Shown" is stated as a requirement rather than an aspiration because the first
implementation of this section dropped fact-lag from the verdict, kept fetching it, and rendered it
nowhere: a promise in a spec with no surface behind it.

### 3d. Both halves of the lag must count THE SAME EPISODES

`newestEpisodeAtMs` is team-scoped (`where team_id = $1`). The liveness read must therefore be scoped
to that team's ledger `group_id`s, or the subtraction compares two different populations: the first
draft read `max(Episodic.created_at)` across the whole database, so on an instance hosting more than
one team, ANY other team completing a job refreshed this team's clock and its dead extractor read
green forever. That is strictly worse than the fact-scope asymmetry it replaced, which needed the
other group to produce a genuinely NOVEL fact — rare, by this document's own §1 argument. Found by
both reviewers independently.

Group is only one of the two axes, and the second was missed until a fourth review round: scoping by
group alone still counted `correction:<arc_id>` episodes, which `lib/graph/arcs.ts` POSTs directly to
Graphiti in the **same team group** with **no `graph_episodes` row**. The denominator counts ledger
rows; the numerator was counting ledger rows plus arc writebacks. Concretely: item extraction is dead,
an admin recomputes an arc that carries a human correction, the correction episode completes, and the
clock goes fresh — the alarm stays silent for the full budget, mid-outage. So the liveness read also
filters on `ITEM_EPISODE_PREFIX`, a **positive** match on the projector's own naming constant rather
than a `correction:` denylist, so the next non-ledger episode kind is excluded by default instead of
requiring someone to remember a new rule.

No performance claim is made for either filter. An earlier draft of this section said the global form
was "a label scan"; review corrected it — graphiti creates both `episode_group_id` and
`created_at_episodic_index` on `Episodic` (`graph_queries.py:65`, `:75`), so both forms are
index-supported. The scoping is for correctness.

`countGraphFacts` stays deliberately global: "has the extractor ever produced anything at all" is an
install-level question that no team owns, and rescoping it is a different change.

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

No tier surface changes. The new Neo4j read is a single `toString(max(e.created_at))` aggregation
over `Episodic`, returning one timestamp and never a name, a body, or a `group_id`. It is scoped by
the team's ledger `group_id`s (§3d) — since `group_id` is `<slug>_<tier>` and the list comes from the
team-scoped ledger, that is a NARROWING of what the first draft read, never a widening. The remaining
global read is `countGraphFacts`, which is a pre-existing count with its own documented rationale. No
new API route, no new table, no change to `visibleItems`/`visibleTasks`/`visibleGroupIds`.

## 4. Acceptance criteria

- `test/graph-extraction-health.test.ts` — facts lagging past the budget but a FRESH episodic node (within budget of the newest episode) is **NOT** stalled — the reported false positive, and the dedup-freeze case.
- `test/graph-extraction-health.test.ts` — episodes projected but the newest episodic node older than the budget **IS** stalled — the real "202 accepted, nothing processed" outage, now covering the Neo4j write too.
- `test/graph-extraction-health.test.ts` — `facts === 0` above the episode floor is stalled **even when** the episodic node is fresh (never-extracted outranks liveness).
- `test/graph-extraction-health.test.ts` — a `null` episodic timestamp never manufactures a stall, and never suppresses the `facts === 0` case.
- `test/graph-extraction-health.test.ts` — `extractionStallCause` returns `never-extracted` only when `facts === 0`, and `stopped` otherwise, so no surface can claim "0 facts" about a liveness stall.
- `test/graph-extraction-health.test.ts` — `extractionStallReason("stopped", …)` contains no "0 facts" claim and degrades to "for some time" on a null `lagHours` rather than printing "nullh".
- `test/graph-extraction-health.test.ts` — the liveness query filters on `ITEM_EPISODE_PREFIX`, sharing one constant with the projector's `episodeName`, so an arc-correction writeback (`correction:<arc_id>`, no ledger row) cannot refresh the clock.
- `test/datamechanics/graph-extraction-scope.datamechanics.test.ts` — real Postgres: `teamEpisodeGroupIds` returns only THIS team's groups and excludes groups that hold nothing but `''`-sentinel rows; `countProjectedEpisodes` excludes sentinel rows, so redaction tombstones cannot help clear `MIN_EPISODES_FOR_EXTRACTION_SIGNAL`.
- `test/guards/extraction-stall-callsites.test.ts` — a build-failing guard: EVERY `deriveGraphExtractionStalled(` call site in every tree `tsconfig` typechecks (`lib/`, `app/`, `components/`, `scripts/`) passes `newestEpisodicAtMs`. This exists because the second call site was missed once already.
- `docs/ARCHITECTURE.md` — the graph-extraction row states that liveness is episode-node-derived and team-scoped, that fact-lag is observational and rendered, records the accepted zero-yield blind spot, and records why the two ledger designs were rejected.

## 5. Deliberately NOT in this slice

- **The banner-flap threshold** (`BANNERFLAP-1` / AIO-866, two-consecutive-failures) — a different
  defect in a different file; batching them would make one PR unreviewable.
- **The census sample floor** (`CENSUSFLOOR-1` / AIO-867) — already specced separately.
- **The canned `Output length exceeded` example string** is removed from the admin card, which now
  renders the server's reason verbatim instead of composing its own copy. Rewriting the whole
  reason-string taxonomy is still not in scope.
- **A backstop for edge-yield death** — `extract_edges` legally returning `[]` on every episode leaves
  every surface green (see the accepted-blind-spot note in `lib/graph/extraction-health.ts`). Detecting
  it needs an edge-yield-per-episode sensor with a measured band, which is the `PIPEFF-2`
  `entitiesPerEpisode` pattern applied to edges — its own slice, and its band must be measured, not
  invented.
- **De-duplicating the two surfaces** (one probe rendering as two failures) — the fix removes the
  false positive that made the duplication visible; collapsing the surfaces is a UI change with its
  own product question.

## 6. What would falsify this

If, after the change, a genuinely dead extractor (provider 429, container wedged, Neo4j write
failing) failed to raise the stall within the lag budget, episode-node liveness would be too
permissive — something other than a completed `add_episode` would have to be writing `Episodic`
nodes. Two things are the guard against that inversion: the "IS stalled when episodes are pushed and
NO job completes" criterion above pins the direction that must not weaken, and the source audit
above enumerates every `EpisodicNode` write in the pinned wheel (`add_episode`, `add_episode_bulk`
which we do not call, and `add_triplet` which never persists one).

The opposite falsifier — the one this slice is actually betting on — is a recurrence of the reported
false positive: a red stall beside a census reporting new entities and a clean `llm_usage` trail. If
that happens again after this ships, episode-node recency is not the liveness signal it is claimed to
be, and the next place to look is whether the graph service moved to `add_episode_bulk`.
