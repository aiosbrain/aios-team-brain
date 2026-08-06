# Lever 2 — stop paying for predecessor episodes that carry nothing

**Status:** **CLEAR** after four plan-review rounds — 3 blockers + 2 HIGHs, one of which inverted a
finding of mine and reshaped the lever · **Date:** 2026-08-06 · **Owner:** Chetan
· **Task:** `PIPEFF-2` → [AIO-821](https://linear.app/je4light/issue/AIO-821)
· **Parent:** `PIPEFF-1` / [AIO-820](https://linear.app/je4light/issue/AIO-820) —
  [`graph-ingestion-efficiency.md`](./graph-ingestion-efficiency.md)
· **Depends on:** the measurement harness (`scripts/graph-ingest-cost.mjs`, merged as `efdda1b`)

## The problem, in one number

Every `add_episode` retrieves **ten previous episodes** and carries their full content into **four
metered LLM calls**. At ~625 tokens each that is **~6,250 tokens of predecessor context per call** —
the single largest term in the ~40,070 input tokens per episode the harness measured.

## What the window actually is — re-derived, and it is not what the parent spec assumed

Read from `graphiti_core==0.29.3` (the exact pin in `graphiti/Dockerfile`) and from
`/app/graph_service` inside the built image `aios-graphiti:0293-pinned`.

### 1. One call site, one occurrence

```python
# graphiti_core/graphiti.py:1087-1093   (`name` is in scope — add_episode's first parameter)
previous_episodes = (
    await self.retrieve_episodes(
        reference_time,
        last_n=RELEVANT_SCHEMA_LIMIT,      # ← 10
        group_ids=[group_id],
        source=source,
    )
    if previous_episode_uuids is None
    else await EpisodicNode.get_by_uuids(self.driver, previous_episode_uuids)
)
```

`grep -rn 'last_n=RELEVANT_SCHEMA_LIMIT' graphiti_core/` returns **exactly one line**. The constant
itself is defined in `search/search_utils.py` and appears there **15 times** (1 definition + 14 uses)
as the **query-time retrieval limit** — so patching the *constant* would silently narrow search
quality, a different feature. **Patch the call site.** (Both this spec's earlier draft and the parent
spec said "~20 sites"; the number is 15. Both also called it the dedupe-candidate limit — it isn't:
that cap is `NODE_DEDUP_CANDIDATE_LIMIT = 15` at `node_operations.py:64`. Immaterial to the
don't-patch-the-constant decision, but the parent spec is corrected in the same PR.)

### 2. The server can never take the other branch

`graph_service/routers/ingest.py:57` calls `add_episode(uuid, group_id, name, episode_body,
reference_time, source, source_description)` — **no `previous_episode_uuids`**. The REST surface the
brain uses always takes the `retrieve_episodes` branch.

### 3. The window is same-**group**, not same-**document**

```cypher
MATCH (e:Episodic) WHERE e.valid_at <= $reference_time
AND e.group_id IN $group_ids AND e.source = $source
ORDER BY e.valid_at DESC LIMIT $num_episodes
```

Predecessors are the ten episodes in the same group (`<teamSlug>_team` / `_external`) with the
nearest earlier `valid_at`, regardless of which item they came from.

### 4. …but for a multi-chunk item, its own prior chunks are *guaranteed* to be selected

**This corrects the previous draft of this spec, which claimed the opposite and built its prediction
on it.** The derivation the reviewer supplied, which I re-checked:

- The graph service runs a **single sequential FIFO worker** (`routers/ingest.py`), so chunks
  `0..k-1` are persisted before chunk `k` is processed.
- `lib/graph/project.ts:toEpisodes` stamps every chunk with one `pickEpisodeTimestamp(item)`, so all
  of an item's chunks share `valid_at` — and that value **equals** `reference_time`, which is the
  *maximum* value the `valid_at <= reference_time` filter admits.
- `ORDER BY valid_at DESC` therefore ranks every equal-max row **above** every strictly-earlier row.

So chunk `k` receives all of its own prior chunks (up to 10). What is genuinely unpinned is only
(a) their **order** within the prompt and (b) which rows survive `LIMIT 10` if the tie pool exceeds
ten — either because the item has more than 11 chunks, or because another item carries a
byte-identical `valid_at` (possible where `pickEpisodeTimestamp` resolves to a date-granular
`worked_at`; **Phase A measures how often that happens**).

**The consequence, and it reshapes the lever:**

| item shape | what the 10 predecessors carry | verdict |
|---|---|---|
| **single-chunk** (40% of items are under 600 chars) | ten **unrelated** items | pure cost, nothing to resolve |
| **multi-chunk** | its own prior chunks first, unrelated items only as filler | the coreference mechanism, working |

The waste and the value are cleanly separable by item. So the right lever is **not** a smaller
number — it is *"carry the document's own predecessors and nothing else."*

## The lever: a same-item filter, with `last_n=1` as the blunt fallback

Episode names are `items:<id>` (single chunk) or `items:<id>#k` (`lib/graph/episode-name.ts`), and
`name` is in scope at the call site. So the filter is a post-retrieval predicate on the name's
pre-`#` prefix — the Cypher query is unchanged (retrieval is not an LLM call and costs nothing worth
optimising); only what reaches the four prompts changes.

- **single-chunk item** → **zero** predecessors (better than `last_n=1`, and **provably loses no
  same-document context**: no predecessor could have been the same document)
- **multi-chunk item** → all of its own prior chunks, up to 10 (the mechanism preserved intact)

### What the filter *can* still cost — and why the first draft's gates were blind to it

An earlier draft called the single-chunk case "provably lossless". That overclaims, and the failure
it hides is this repo's own documented incident class. Unrelated predecessors do two real jobs:

1. **Name canonicalization at extraction** — a chunk saying "John" extracts the canonical "John Smith"
   when a predecessor named him in full; without one it extracts "John".
2. **Dedupe judgment context** — `_resolve_with_llm` embeds full predecessor content into the
   `dedupe_nodes` prompt (`node_operations.py:539-548`) precisely so the model can decide whether
   extracted-"John" *is* candidate-"John Smith". With no context, the safe answer is **don't merge**.

(Candidate *retrieval* is unaffected — candidates come from embedding similarity capped at
`NODE_DEDUP_CANDIDATE_LIMIT`, `node_operations.py:418-452`. It is the *judgment* that loses context.)

The resulting failure is **cross-item entity fragmentation**: one person or project as several
parallel nodes. Check that against the direction of each band in the first draft and every one of
them passes:

| gate | what fragmentation does to it |
|---|---|
| entity yield ≥ 90% | fragmentation **raises** node count → PASS |
| people recall | conditioned on the full name appearing literally, so the partial-name case is excluded from the denominator by construction → blind |
| dupe share ≤ W10 + 5pp | a failure-to-merge emits **no** `IS_DUPLICATE_OF` edge, so the share **falls** → PASS |
| cross-chunk continuity | within-item only; SAME preserves own-chunk context → PASS |

So the first draft's battery would have cleared an arm that fragmented the graph's identity layer —
the AIO-693 class. It applies to the `W1` arm too (1 unrelated predecessor instead of 10), so it is a
battery gap, not a SAME-specific one. **Q3 becomes two-sided and Q6 is added below.**

`last_n=1` — the parent spec's proposal — remains in the battery as the **blunt floor**: it is a
smaller patch, and if the same-item filter fails to cut enough tokens (a corpus dominated by long
documents), `last_n=1` is the fallback whose quality cost we will then have measured rather than
guessed.

## Phase A — measure what the ten predecessors actually contain, before any A/B

One local run at the **current** window (10) with request bodies captured. **Capture mechanism,
decided here rather than at build time:** a thin local forwarder sits between graphiti and the local
brain, appends each request body to a JSONL, and forwards unchanged — so metering still traverses the
production path (`graph-proxy` → `classifyGraphCall` → `recordLlmUsage`) and nothing about the cost
shape is simulated. Nothing in the proxy or `llm_usage` stores prompts, and this spec is not going to
add prompt storage to a production path to run an experiment.

Measured **across all four metered carriers** — `extract_nodes`, `extract_edges`, `dedupe_nodes` and
`node_summaries_batch`:

| measured | why it decides the design |
|---|---|
| predecessor tokens per call, **per call kind** | sizes the prize; the parent's ~6,250 is derived, not observed, and measuring only `extract_nodes` would understate it |
| **same-item share**, split single-chunk vs multi-chunk | the prediction from §4 is ~0% and ~100% respectively; a blended number would hide both |
| **tie-pool contamination** — how often a *different* item shares an episode's exact `valid_at` | the one way §4's guarantee can break; if it is common, the same-item filter is worth more, not less |

> `node_attributes` is **not** a fourth carrier on this install: with no custom entity types,
> `_extract_entity_attributes` returns `{}` with no LLM call (`node_operations.py:783-791`). The
> fourth metered carrier is `node_summaries_batch`, which embeds full predecessor content
> (`node_operations.py:948-963`). The parent spec names the wrong one.

Phase A's numbers are written into this doc **before** Phase B runs, so the prediction is on the
record before the result exists.

### Phase A, part 1 — the structural half, measured 2026-08-06 at **zero LLM cost**

Two of Phase A's three questions turned out not to need a run at all. Given the tie-rank guarantee
(§4), the same-item share is **derivable** from the corpus shape, and tie-pool contamination is a
**SQL query against prod**. Both were computed over the pinned 108-episode corpus:

| | result |
|---|---|
| predecessor slots that are **unrelated items** | **617 of 1,080 — 57.1%**, pure billed waste |
| same-item share, **single-chunk** items | **0%** (200 slots, all filler — nothing to be a chunk of) |
| same-item share, **multi-chunk** items | **52.6%** (the rest is filler because chunk *k* has only *k* predecessors of its own to offer, and *k* < 10 for most chunks) |
| tie-pool contamination | **every** corpus item has a rival sharing its exact `work_at`; worst is 40 rival episodes |
| own-chunk slots the guarantee actually delivers | **95.1%** (440 of 463) |

**The contamination is real but lands where it costs least.** The multi-chunk *documents* — the
population Q4 measures — carry **1 rival episode each** and keep 95–100% of their own-chunk slots.
The heavy displacement (2.3 of 10 slots kept) is confined to small Linear items sharing a `work_at`
with a 40-episode batch, which had little own-context to lose. So §4's guarantee is sound in
practice for the case it matters for.

**Which graph state this applies to.** These are **prod steady-state** numbers: they assume every
episode finds a full ten-slot window. A Phase A/B run starts from an **empty Neo4j**, so the first
~10 episodes have fewer predecessors available and carry less filler than the model says. That is
~55 of 1,080 slots — it moves no verdict, but the comparison must be made against the same state, so
the runner reports the warm-up episodes separately rather than blending them in.

**The prediction this puts on the record, before Phase B runs:** the `SAME` filter removes **57.1% of
all predecessor slots** as carrying nothing, and makes the remaining 43% *deterministic* rather than
95% deterministic. Since the predecessor block is the largest term in the ~40,070 input tokens, C1's
25% band should be cleared comfortably — and if it is not, the token accounting is wrong somewhere
and that is itself the finding.

**What still needs the stack:** the *size* of the predecessor block per call kind — the parent spec's
~6,250 tokens is derived, not observed — across all four metered carriers. That is the only part of
Phase A that spends money.

## Phase B — the battery

Three arms, each replaying the **same corpus in the same order into a fresh, empty Neo4j**, at the
same model and temperature as prod:

| arm | patch |
|---|---|
| **W10** | incumbent — unpatched |
| **SAME** | same-item filter (the designed fix) |
| **W1** | `last_n=1` (blunt floor) |

`last_n` is not env-configurable, so each arm is a **locally built image variant** off
`graphiti/Dockerfile`. Local topology per arm: neo4j + that graphiti variant + the capture tap +
`next start` (the brain) + the `db:test:up` Postgres — **on its own container/ports**, because a
shared test Postgres has previously made concurrent runs look like product bugs.

### The corpus is this install's own content, pulled at run time

Never a checked-in fixture. `EXMODEL-1` failed exactly there: the repo is public, so the fixture had
to be synthetic, and two synthetic attempts scored the *negative control* — the model that actually
polluted the graph — as a pass and the good model as a fail. A fixture iterated until it agrees with
the conclusion is the failure this workstream exists to prevent.

The battery copies the selected `items` rows, the `members` rows (Q2/Q6 need them) and the `teams` row
from prod (read-only) into the local Postgres. Content stays local; nothing is committed.

**Three things beyond rows are required before a single call can flow**, named here because omitting
one produces a stack that boots and then does nothing:

1. the team's **`integrations` row copied verbatim, still encrypted**, plus `SECRETS_KEY` read from
   Railway — so the provider key is never materialised into a file at any point;
2. **`GRAPH_LLM_PROXY_SECRET`** set identically on the brain, the capture tap and graphiti
   (`authorizeGraphProxy` fails **closed** when it is unset — by design);
3. **`GRAPH_LLM_TEAM`** = the seeded team's slug, or `resolveGraphProxyTeamId` refuses rather than
   guessing.

**Selection rule, fixed in advance, buckets disjoint by construction, `access = 'team'` only:**

| bucket | rule | episodes (measured) |
|---|---|---|
| A | the **3** most recent items of **≥ 8 chunks** | 57 |
| B1 | the **15** most recent items of **exactly 1 chunk, < 600 chars** | 15 |
| B2 | the **5** most recent items of **exactly 1 chunk, ≥ 600 chars** | 5 |
| C | the **8** most recent items of **2–7 chunks** | 31 |

> **Amendment, 2026-08-06, before any session ran — bucket A: 5 → 3.** Run against this install, `A: 5`
> selected 9, 8, 40, 23 and 22-chunk items: **102 episodes in bucket A alone, 153 in total**, against
> the ~100 this spec assumed. That is not just a cost overrun — **Q5's band is derived from the corpus
> size.** At ~100 episodes one validation retry moves the signed gap by ~1 pp, which is the entire
> reason the band is 3 pp and its ceiling 1.5 pp. At 153 episodes one retry is 0.65 pp, so the same
> pre-registered ceiling would silently tolerate **2.3 retries instead of one** — the number unchanged,
> its meaning changed. Fixing the corpus size preserves the coupling; re-deriving the band after
> seeing a corpus would not. `A: 3` measures **108 episodes**, one retry ≈ 0.93 pp, and the
> single-chunk episode share moves from 13.1% to **18.5%** — *closer* to prod's ~17%, which matters
> because C1 is corpus-mix-sensitive. `selectCorpus` now refuses outside **90–120 episodes**
> (`EPISODE_BUDGET`), so a future draw cannot break the coupling quietly.

The four buckets **partition** the corpus by chunk count — an earlier draft's "1 chunk *and* <600
chars" against "2–7 chunks" left a 1-chunk-but-large item in no bucket at all, the same class of hole
as the 4–7-chunk gap before it.

**108 episodes per rep, of which 18.5% are single-chunk-item episodes** — against **~17% in prod**
(898 of 5,166). Both numbers are measured, not estimated. That match is what makes the blended C1
transferable, and C1 is corpus-mix-sensitive, so it is stated rather than left implicit.

The `access='team'` restriction is what makes this land in **one group** — by selection, not by
bypassing the projector (see below). The selected item ids are **pinned in the report** so a later
run is comparable rather than merely similar.

**Q2/Q6 power extension, deterministic:** if the corpus yields fewer than **15** literal member-name
occurrences (Q2), or fewer than **5** member names present in ≥2 distinct items (Q6), extend bucket C
by the next most-recent qualifying items, up to **+10**, until it does. If it still does not, that
metric is **UNDERPOWERED**, which **invalidates the session** — it does not count as a FAIL. A corpus
that cannot produce enough names is a power failure, not evidence of a regression, and the spec
already draws that distinction for harness refusals.

### The push is the real projector run path

**The battery drives `runGraphProjection`** against the local Postgres with `GRAPHITI_URL` pointed at
the arm's graphiti. Not a bespoke loop over `chunkContent` + REST. This is a blocker-level
correction, and the reason is specific:

`scripts/graph-ingest-cost.mjs` cross-checks `extract_nodes` calls against `ingest_runs.meta.
episodes`, which **only the projector run path writes** (`lib/graph/projection-run.ts:21-31`). With a
bespoke pusher there is no such row, `episodesPushed` is `null`, and the harness prints
"cross-check unavailable" **and reports the ratios anyway** (`graph-ingest-cost.mjs:137, 253` — a
null is not a refusal). Q5 would then be silently unmeasurable, and C1 would lose its guard: the
denominator counts **attempts**, so a patch-induced rise in validation retries inflates it and
manufactures a token-per-episode "saving" — C1 stays green through the exact failure Q5 exists to
catch.

**So: cross-check unavailable ⇒ the run is INVALID, not "report with suspicion."** Same for any
harness refusal (drain, zero episodes).

### Metrics and pass bands — pre-registered

Every band is relative to the **W10 arm measured in the same session**. No stored answer key, no
absolute target except where noted: the question is *"is this worse than what we have"*, asked
against this install's own content.

| # | metric | derived from | band |
|---|---|---|---|
| Q1 | **entity yield, TWO-SIDED** | `Entity` nodes per episode | within **± 10%** of W10 — an *increase* is as disqualifying as a fall |
| Q2 | **people recall** | member names appearing literally in a chunk's text, found as an `Entity` in that group | ≥ **95%** of W10 **and** at most **1** person lost outright — the count clause is **noise-free** (see below) |
| Q3 | **duplicate pollution, TWO-SIDED** | `IS_DUPLICATE_OF` share of edges, via **`lib/graph/extraction-health.ts`'s own Cypher predicate** (pinned by `test/guards/dedupe-predicate-pinned.test.ts`) | within **± 5 pp** of W10 — a *fall* is as disqualifying as a rise |
| Q4 | **cross-chunk entity continuity** | buckets A + C only: share of an item's entities appearing in ≥ 2 of its chunks | ≥ **85%** of W10 |
| Q5 | **signed retry gap** | `(extract_nodes − episodesPushed) / episodesPushed`, in pp — the harness's `signed`, normalised | must not rise by more than **3 pp** vs W10 |
| Q6 | **cross-item entity convergence** | over member names appearing literally in chunks of **≥ 2 distinct items**: distinct `Entity` nodes carrying that name ÷ distinct names matched, **case-normalised on both sides** | ≤ **105%** of W10 |
| C1 | **input tokens per episode** | the harness | must fall by ≥ **25%** vs W10 |

**Q4 and Q6 are the two metrics that test mechanisms rather than symptoms.** Q4 catches the loss of
*within-document* context — Q1–Q3 would all stay green while cross-chunk references stopped
resolving. Q6 catches the loss of *cross-item* dedupe judgment described above, which is the only
gate whose direction is right for fragmentation; it deliberately reuses Q2's member-name machinery
rather than inventing a second identity notion.

**Q1's and Q3's upper/lower bounds are not symmetry for its own sake.** `extraction-health.ts` already
treats an anomalously *low* duplicate share as suspect, and failure-to-merge is exactly how the share
falls while the graph gets worse. Q1's new **upper** bound is the catch-all for the fragmentation
Q6 cannot see: the canonicalization failure above yields a node named `"John"`, which carries no
member name at all and so never enters Q6's denominator — but it does inflate node count. A one-sided
Q1 would have waved it through.

**Q6 reports a per-name breakdown, not only the ratio.** The aggregate can stay flat while the arm
fragments name A and W10 happens to fragment name B. That case is rare and not disqualifying on its
own, but it must be *auditable* rather than invisible, so the per-name counts go in the report.

Q2's two clauses are both floors and the stricter binds; at realistic n the 95% clause is usually the
operative one, and the "1 person" clause only bites on a small denominator.

**The count clause takes no tolerance and yields no INCONCLUSIVE**, unlike every other gate. Applying
a spread to an integer count of people would swallow the clause whole — any spread ≥ 1 makes "lost 2"
and "lost 0" indistinguishable — which deletes the floor it exists to be. Losing two known people
outright is not a statistical question. Both clauses are executable in
`scripts/graph-window-battery/decision.mjs`, and it **refuses to judge Q2 at all** if the count was
never measured, so the clause cannot be satisfied by omitting its input.

**Q4's per-chunk attribution is real, not assumed:** 0.29.3 persists `(:Episodic)-[:MENTIONS]->(:Entity)`
per episode (`models/edges/edge_db_queries.py:22`), built in `_process_episode_data` over the
**resolved** (post-dedupe, canonical) nodes — so Q4 measures whether resolution converged across
chunks, which is what it is for. The item id must be parsed with `itemIdFromEpisodeName`'s exact
logic, **never** `STARTS WITH 'items:<id>'`, which would swallow `items:123` into `items:12`.

### The decision function — total, and fixed before any number exists

The previous draft pre-registered bands *and* a noise rule, and never said what happens when a metric
lands below its band but within noise. That gap is a joint that gets chosen after the numbers exist —
EXMODEL-1's failure re-entering through analysis flexibility instead of through the fixture. So:

**Aggregation.** Each arm runs **2 reps** on the same corpus into a fresh database. An arm's value
for a metric is the **mean of its two reps**. Ratios use the mean of W10's two reps as denominator.
W10's own **spread** — `|rep1 − rep2|`, expressed in the same units as the band — is the noise
estimate.

**Per metric, exactly one of — and the rule is SYMMETRIC about the band:**

- **PASS** — the arm's mean beats the band by **more than** W10's spread.
- **FAIL** — the arm's mean misses the band by **more than** W10's spread.
- **INCONCLUSIVE** — the arm's mean lands **within ± spread** of the band.

**INCONCLUSIVE counts as FAIL for shipping.** The burden of proof is on the change: a metric we
cannot distinguish from a regression is not evidence that there is none.

**Why the PASS side has to carry the spread too.** An earlier draft required only "the mean meets the
band", which made the noise estimate irrelevant to every above-band outcome — and since the bands are
*multiplicative in W10's mean*, that let noise work in the shipping direction. Worked example: true
W10 entity yield 10.0/episode, SAME's true value 8.5 (a real 15% regression that should fail the 90%
band). W10's reps come in at 10.2 and 6.0 — one rep quietly degraded by a provider brownout that
completes every episode and so trips none of the invalidation conditions. W10 mean 8.1 → band 7.29 →
SAME's 8.5 **passes**. More noise, easier shipping — the exact opposite of what the Risks section
claims. Under the symmetric rule the band is 7.29 + 4.2 = 11.5 and SAME correctly fails.

**The validity ceiling is expressed in BAND units, not as a fraction of the mean.** An earlier draft
said "spread > 25% of W10's mean ⇒ INVALID", which is degenerate in both directions:

- **Too tight where the healthy mean is ~0.** Q5's healthy W10 value is ≈ 0 (the prod baseline
  cross-checked *exact*), so 25%-of-mean ≈ 0 and **a single validation retry in one W10 rep**
  invalidates the session. The battery could plausibly never complete a valid session.
- **Too loose where the band is tight.** At a healthy W10 dupe share of 30%, the ceiling permits a
  spread of 7.5 pp — but Q3's band is ± 5 pp, and PASS requires sitting more than `spread` inside
  *both* edges, so the PASS window is **empty**. A session would be valid with a metric no arm could
  ever pass.

A decision procedure that can deadlock mid-experiment is the failure this spec exists to prevent,
because a deadlock is what gets rewritten under pressure. So, per metric:

> **W10's spread must be ≤ half that metric's band margin**, with an absolute floor where the healthy
> mean sits near zero. Otherwise the session is **INVALID** — not a result, a broken instrument.

| metric | band margin | max W10 spread |
|---|---|---|
| Q1 | ± 10% of W10 | 5% of W10's mean |
| Q2 | 5% | 2.5% |
| Q3 | ± 5 pp | 2.5 pp |
| Q4 | 15% | 7.5% |
| Q5 | 3 pp | **1.5 pp** (floor: at ~100 episodes one retry ≈ 1 pp, so one retry of rep-to-rep difference is tolerated and two is not — which is why Q5's band is 3 pp rather than 2) |

| Q6 | 5% | 2.5% |
| C1 | 25% | 12.5% |

**This construction also guarantees every PASS window is non-empty in a valid session.** For the
two-sided bands that is the whole point: Q3's window is `(W10−5+s, W10+5−s)`, non-empty iff
`s < 5 pp`, and the ceiling is 2.5. Q1's band is two-sided *and multiplicative* — edges `0.9M` and
`1.1M`, window non-empty iff `s < 0.1M` — and its ceiling is `0.05M`, which scales with the **same
`M`** as the edges, so the inequality holds identically for every `M > 0`. That is structurally
unlike the old rule, which used the mean as a *universal* scale including for Q5, whose mean is
legitimately ≈0 and has nothing to do with its band width; here the scale is the band, and the two
metrics with dangerous means (Q3, Q5) carry absolute-pp ceilings. (For the one-sided bands the PASS
region is a half-line and is non-empty for any spread — there the ceiling is doing a different job,
namely stopping the same two reps from setting both the bar and the noise gate too coarsely.)

**Why Q5's band is 3 pp and why widening it did not cost the guard its teeth.** A validation retry
adds one attempt to C1's denominator and one metered `extract_nodes` call — ~8,400 input tokens,
well under the ~40,000/attempt baseline — to its numerator, so retries drag tokens-per-episode
*down*. At 100 episodes with the full 3-retry allowance:
`(100 × 40,070 + 3 × 8,400) / 103 ≈ 39,148` — a **−2.3% artifact against a band that demands −25%**,
about a tenth of the required movement, and the symmetric rule already requires beating 25% by more
than W10's C1 spread on top of that. The bound is conservative in the right direction, too: retry
prompts are *longer* than the originals (the error context is appended), which raises the added
numerator and shrinks the artifact further.

**One further sanity gate, borrowed from the module that already owns the question:** if W10's own
duplicate share falls outside **15–45%**, the session is INVALID — a baseline outside that range is
not worth comparing against.

- The **45%** is not padding: it is `DEDUPE_ABSOLUTE_FLOOR = 0.45` (`extraction-health.ts:284`), the
  module's own constant, sitting above every healthy reading on record (~26–35%) and below the
  degraded model's ~70%.
- The **15%** has no module counterpart, and the reason it is below prod's healthy range is
  structural rather than arbitrary: **the battery runs into a fresh, empty Neo4j**, so early episodes
  have no existing candidates to duplicate against and the blended share over ~100 episodes sits
  below prod's steady state by construction. If a first valid W10 arm still lands under 15%, that is
  an **amendment case** — the number gets re-derived on the record, not silently re-padded.
- The module also refuses to judge the share below `MIN_EDGES_FOR_DEDUPE_SIGNAL = 200` edges
  (`:272`). **The battery adopts the same minimum-sample refusal for Q3 and Q6**; ~100 episodes
  should clear it comfortably at prod's edge rates, so it is a cheap tripwire rather than a burden.

**Arm order and outcome:**

1. Evaluate **SAME**. All of Q1–Q6 and C1 PASS → **SAME ships**.
2. Else evaluate **W1** on the identical rule → **W1 ships**.
3. Else **the lever does not ship**, and the negative result is committed to this doc. Cutting the
   context is then off the table until the `previous_episode_uuids` alternative is spec'd (below).

C1's ≥25% applies identically to every candidate arm: a quality-clean arm that barely moves tokens
does not justify a deploy of this service (see *Rollout*).

**Rerun policy — and which session BINDS.** "Most recent" re-draws the corpus each session, so
logging reruns makes multiplicity *visible* without closing it: running sessions until one passes and
shipping on the passer would still be legal under a log-everything rule. So:

- **every started session's outcome is appended to this doc**, pass or fail, with its pinned item ids;
- **the first valid session's verdict binds.** A further session may only follow a **committed
  amendment to this spec** stating what is being changed and why;
- shipping requires the latest valid session to pass **and** no prior valid session to have failed the
  same arm without that amendment on the record;
- a session is *invalidated* only for a **pre-defined** reason — a harness refusal, an unavailable
  cross-check, an arm that failed to complete every episode, an UNDERPOWERED Q2/Q6, a W10 spread over
  its per-metric ceiling, or a W10 duplicate share outside 15–45% — **never for its numbers**.

**Invalidation is a free retry, so it is capped.** The amendment gate binds only *valid* sessions, and
it has to — an infra failure must not deadlock the battery. But one trigger is operator-inducible:
killing a container mid-arm invalidates a session that was trending badly, and next week's redraw then
needs no amendment. So the redraw joint is closed on the invalid side too:

- an invalidated session still has its **partial metrics computed and appended** to the session log,
  with the invalidation cause attached — so a run that was going badly leaves the same trace as one
  that was going well;
- **more than two consecutive invalidations** without an intervening committed amendment **block
  further sessions**. If the battery cannot complete twice running, the instrument is what needs
  fixing, and that fix belongs in this doc before more money is spent.

> **These two rules are load-bearing on each other and must not be edited independently.**
> *Consecutive* is a safe counter **only because a valid session binds**: resetting the counter
> requires completing a valid session, and a valid session is never neutral — a valid FAIL binds
> against the arm, a valid PASS ends the experiment. So interleaving a "sacrificial" valid run to
> reset the count is self-defeating, and before the first valid session *consecutive* ≡ *total*. If a
> future edit ever softens "the first valid session binds", *consecutive* silently becomes a real
> hole and must become a total count in the same change.

**Estimated spend: ≤ $9.53** on the OpenRouter key — 3 arms × 2 reps × 108 episodes at the incumbent's
measured $0.0147/episode, and that is an upper bound because the two candidate arms carry less context
and so cost less per episode. Direct-to-provider from a local brain: the `llm_usage` **rows** land
in the local test database (which is what the harness reads), while the **dollars** land on the
provider bill and never in our ledger or the Costs page.

### Prod parity

The local team row mirrors the prod team's `extraction_provider`/`extraction_model` **and its
small-extraction backend** — `resolveGraphChatTargets`/`selectSmallExtractionBackend` returns
`small: null` when unconfigured, and every small-marked call then silently lands on the strong model,
so an unmirrored small setting measures a cost shape prod does not have. **Both resolved targets are
printed in the battery's report.**

## Phase C — the patch, only if Phase B clears

A `sed` in `graphiti/Dockerfile` in that file's established style: a `grep` asserting the pre-state
(and its uniqueness), a `grep` + `ast.parse` asserting the post-state, so a base-image change that
moves the line **fails the build** rather than silently no-op'ing. That silent no-op is the class the
Dockerfile's own comments exist to prevent, and is exactly what the parent spec's original
`EPISODE_WINDOW_LEN = 3` proposal would have been.

**Placement is load-bearing:** the RUN must come **after** the `pip install` RUN, or pip overwrites
the edit and every gate still passes against the pre-install file — the precedent is patch 2's own
comment at `graphiti/Dockerfile:102`. A final assertion RUN after **all** installs re-greps the
post-state, so ordering cannot silently regress.

**The sed that ships is the sed that was measured, byte for byte** — lifted from the arm's image and
recorded in the session log, not re-derived at ship time. This matters more for `SAME` than for `W1`:
`W1` is a one-argument swap, while `SAME` is a multi-line Python insertion, and a "cleaned up"
re-derivation is precisely how a measured result gets attached to an unmeasured patch.

```
F=/app/.venv/lib/python3.12/site-packages/graphiti_core/graphiti.py
test "$(grep -c 'last_n=RELEVANT_SCHEMA_LIMIT,' "$F")" = "1"          # pre-state + uniqueness
sed -i '<the winning arm's sed, VERBATIM from the image the battery ran>' "$F"
grep -q '<post-state marker, incl. a PIPEFF-2 comment>' "$F"
python -c "import ast; ast.parse(open('$F').read())"
# the constant's own uses are untouched — hardcoded, not "unchanged":
test "$(grep -c RELEVANT_SCHEMA_LIMIT .../search/search_utils.py)" = "15"
```

### Rollout and rollback

Deploying the `graphiti` service is not routine: **restarting or var-touching it has previously
rebuilt a broken image**, and recovery is a **dashboard rollback to a recorded deployment ID** —
never `railway up` / `redeploy` (denied by `.claude/settings.json` and a PreToolUse hook).

1. Record the current deployment ID **before** the change.
2. Confirm the service still has **no custom start command** — a start command re-syncs the venv at
   boot and silently reverts every patch in the image (the ⚠️ precondition in the Dockerfile).
3. Merge → Railway builds from `graphiti/`. **`docs/ARCHITECTURE.md` is updated in the same PR**
   (CLAUDE.md §1).
4. **Verify in the ledger, not the logs:** input tokens/episode on the same harness, over a
   drain-clean prod window after the deploy, against the pre-deploy baseline — and read the signed
   cross-check, not only the ratio.
5. Watch Q3 in prod via the **dedupe-pollution alarm (AIO-693)**, live, which emails admins on the
   ok→polluted edge. That alarm is the backstop for a quality regression the battery missed.

Rollback is data-safe in the same sense the 0.29.3 upgrade was — same labels, same embedder, same
indices — but Graphiti's worker queue is **in-memory**, so episodes accepted (202) and unprocessed at
rollback are lost; confirm the brain's reconcile re-pushed them.

## Alternatives considered

- **Patch the constant `RELEVANT_SCHEMA_LIMIT`.** Rejected: 14 further uses in `search_utils.py` make
  it a silent search-quality change.
- **Pass `previous_episode_uuids` from the brain.** The most explicit version of the same idea, and
  it lives in *our* code rather than a sed into a vendored library, so it survives image bumps. It
  needs a patch to `graph_service/routers/ingest.py` **and** a new field on the brain's `/messages`
  payload — two surfaces, and the brain would have to track chunk uuids it does not track today.
  **Recorded as the follow-up if Phase B kills both arms**; it gets its own task key when triggered.
- **A hybrid: same-item, falling back to *N* unrelated predecessors when the item has none of its
  own.** Phase A's structural result makes this the *specific* successor if `SAME` fails, so it is
  named now rather than improvised at readout time. The reasoning: the two risks are not evenly
  spread. Multi-chunk items keep their own chunks under `SAME` and lose nothing — they actually gain
  determinism, since rival displacement disappears. **All** the fragmentation risk sits on the
  single-chunk population, whose predecessor slots are 100% unrelated today and 0% under `SAME`. A
  hybrid would keep a small dedupe-judgment context exactly there while still killing the 47% filler
  that multi-chunk items carry. **Trigger: `SAME` fails on Q1-high or Q6 (the fragmentation
  direction) but passes Q4 and C1.** It gets its own task key and its own battery session under an
  amendment — it does not get bolted onto a running experiment.
- **`use_combined_extraction`** (merge node+edge extraction into one call). Unreachable from the
  public API; noted in the parent spec, out of scope here.

## How we will know it worked

Input tokens per episode falls from **~40,070** by ≥25% on the harness, over a drain-clean prod
window after the deploy, with Q1–Q6 unmoved on the battery — and the AIO-693 alarm quiet for a week.

## Risks

- **The battery passes and prod still degrades**, because ~100 episodes of this install's content is
  not every shape of content. Mitigated by the AIO-693 alarm as the live backstop and by the recorded
  rollback path — not by claiming the battery is exhaustive.
- **Two reps is a thin noise estimate.** It bounds noise crudely; it cannot prove a small regression
  absent. The **symmetric** PASS/FAIL/INCONCLUSIVE rule is what makes a thin estimate safe rather than
  convenient: because the spread widens the band on *both* sides, more noise is strictly anti-ship.
  (The asymmetric version in the first draft made this sentence false — bands are multiplicative in
  W10's mean, so a degraded W10 rep *lowered* the bar. That is why the rule is symmetric.)
- **A metric can still be blind to a failure nobody enumerated.** Q6 exists because the first draft's
  five gates all pointed the wrong way for entity fragmentation. There is no argument that Q1–Q6 are
  exhaustive — only that each named failure mode now has a gate whose direction is right for it.
- **The same-item filter changes behaviour for non-`items:` episodes** (e.g. `correction:<arc_id>`
  writeback episodes), which would get zero predecessors. That is the intended semantics — a
  correction episode has no document to be a chunk of — but it must be stated, and the Phase C PR
  needs a test that pins it rather than discovering it.

## Session log

_(every started session appended here, pass or fail — see Rerun policy)_

| session | corpus item ids | Phase A result | arm outcomes | verdict |
|---|---|---|---|---|
| — | — | not yet run | — | — |
