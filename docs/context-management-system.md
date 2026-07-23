# The AIOS Team Brain Context-Management System — Complete Overview

**What this is.** A high-level-to-mechanical walkthrough of how the Team Brain ingests, stores,
deduplicates, keeps fresh, retrieves, ranks, grounds, and composes context — every intelligent
behavior baked in, every edge case handled, and every user-facing view built on top, mapped back to
the data model.

**Snapshot:** `main` @ `1b3150a` (2026-07-22). Line references are to files at that commit; treat them
as pointers, not contracts. Authoritative design docs: `docs/design/context-layer-roadmap.md`,
`docs/design/context-retrieval-limits.md`, `docs/design/brain-learning-panel.md`, `docs/ARCHITECTURE.md`.

---

## 1. The mental model

The system is one horizontal spine:

```
ingest → typed units (items/tasks/decisions) → indexed 3 ways (keyword FTS · dense pgvector · graph)
      → composed, tier-safe, cited context → grounded LLM answer
                                     ↘ Learning layer (narrative arcs) as a parallel read
```

Two organs matter most:

- **Organ 1 — Ingestion** (`lib/ingest/*`, single writer `ingestItem`): the *only* legal write path
  for synced content. It dedupes, versions, attributes, diff-syncs derived rows, and keeps everything
  fresh without ever losing prior data.
- **Organ 3 — Retrieval / composer** (`lib/query/retrieve.ts`): turns a natural-language question into a
  ranked, deduped, tier-filtered, grounded, token-budgeted context block with `[S#]` citations.

Between them sits the **Learning layer** (`lib/graph/*`) — a Graphiti temporal knowledge graph plus a
three-tier synthesis: **Layer 1** atomic facts, **Layer 2** events, **Layer 3** LLM-synthesized
narrative arcs.

### Design principles that shape it
- **Single writer + build-failing guard** per data surface (`items` → `lib/ingest`; `item_chunks` →
  `dense-index`; `graph_episodes` → `project`; `ingest_runs` → `runs`; `integrations` → `manage`).
- **Tier isolation is app-code-only** — no RLS backstop. Every read path re-applies the `access` /
  `audience` filter; tier-less tables are *omitted* for external principals, never filtered.
- **Best-effort optional legs** — dense search, graph facts, reranker, external augment, and the
  embeddings backend all degrade to a clean no-op on timeout/misconfig, so a default install is
  byte-for-byte pure-FTS and never 500s a query.
- **Fail loud on silent breakage** — every leg records to `ingest_runs`; health cards + a loud banner
  surface degraded embeddings, a wedged projector, or a stale source.

### Data-model reference

| Table | Role | Sole writer |
|---|---|---|
| `items` | The ingested corpus (Slack, docs, commits, transcripts, tasks-as-items). Has the `search` tsvector generated column. | `lib/ingest.ingestItem` |
| `item_versions` | Append-only history of every changed push (body + frontmatter + sha + author). **Old content is kept here.** | `lib/ingest.ingestItem` |
| `item_chunks` *(optional, pgvector)* | Semantic passages: `vector(1536)` embeddings, HNSW cosine index. | `lib/query/dense-index.indexItem` |
| `tasks` | Structured task rows, diff-synced from item frontmatter; `audience` tier gate. | `lib/ingest` (materialize) |
| `decisions` | Structured decisions; `still_valid` supersession flag; `audience`. | `lib/ingest` (materialize) |
| `meeting_notes` | Metadata layer over transcript items; unique on `source_item_id`. | `lib/meetings/notes` |
| `graph_episodes` | Idempotency ledger for what's been projected into Graphiti. | `lib/graph/project` |
| `arc_cache` | Persisted Layer-3 narrative arcs (SWR cache). | `lib/graph/arc-cache` |
| `graph_entities` / `graph_relationships` | Org-graph actors/commitments/edges (no tier column). | graph sync |
| `ingest_runs` | The observability ledger every leg writes its outcome to. | `lib/ingest/runs.recordIngestRun` |
| `query_log` / chat `conversations` | Usage/spend + saved threads. | query routes / chat store |
| Graphiti/Neo4j | Temporal fact graph (entities + `RELATES_TO` edges). | Graphiti worker (async) |

---

## 2. Part I — Ingestion & storage intelligence

Everything below runs inside `ingestItem()` (`lib/ingest/index.ts:60`), the single validated/audited
write path. Its 5-step contract: **project upsert → existing-item lookup → dedup decision → task-row
validation (before any mutation) → item + version + derived-row materialization**.

### 2.1 Deduplication — content-addressed, at every layer

- **`content_sha256` fast-path** (`index.ts:100`). The hash covers **body + title only** (not
  frontmatter — `reattribution-decision.ts:2`). If the incoming sha equals the stored sha, we take the
  "unchanged" branch: no new version, no re-projection, no re-embed. Every connector re-pushes every
  item every 30-minute tick, so this is what stops a re-sync storm from doing real work.
- **Identity constraint** — `items` is unique on `(team_id, project_id, path)` (`schema.sql:931`): one
  live row per path. New content **replaces in place**; history goes to `item_versions`.
- **Derived-row diff-sync** by `row_key` — `tasks`/`decisions` upsert on `(team_id, project_id,
  row_key)`; sync-originated rows absent from a push are **diff-deleted**, but `origin='ui'` rows
  survive (`index.ts:455`).
- **Semantic chunks** — `item_chunks` unique on `(item_id, chunk_idx)`; `indexItem` is idempotent on
  the item's sha and only re-embeds when the sha moved (never re-charges the embedding API for
  unchanged text — `dense-index.ts:62`).
- **Graph episodes** — `graph_episodes` unique on `(team_id, source_table, source_id)`; the idempotency
  key is `sha(item.body)` over the full body, so re-projection is skipped unless content or tier
  changed (`project.ts:194`).
- **Meeting notes** — unique on `source_item_id` (`schema.sql:1100`); a re-run returns
  `{created:false}` rather than duplicating (`notes.ts:178`).

### 2.2 Chunking — two independent strategies for two indexes

**Dense / semantic chunks** (`lib/query/chunk.ts`): `DEFAULT_MAX = 1200` chars, `DEFAULT_OVERLAP =
150` chars. Split on blank lines → paragraphs; over-long paragraphs split on sentence enders
(`(?<=[.!?])\s+`); still-too-long sentences hard-sliced. Packing is greedy up to `maxChars`, and the
overlap seam is **word-aligned** (trimmed to a space so it never splits mid-word — `chunk.ts:63`).
`maxChars` floored at 200, overlap clamped to `[0, maxChars/2]`.

**Graph episodes** (`lib/graph/project.ts`): `CHUNK_CHARS = 2500` per episode, `MAX_EPISODE_CHUNKS =
16` chunks per item (both env-tunable via `resolvePositiveInt`, which rejects 0/NaN/garbage). A large
item is projected as several small episodes (`items:<id>#0`, `#1`, …). *Why:* Graphiti's own
extraction LLM has a hard output cap (16384 tokens on the patched image); truncating an oversized
item silently drops content and once wedged the whole worker (prod 2026-06/07 incident). Chunking is
the no-loss fix. The median item (~240 chars) is a single chunk. Content beyond `CHUNK_CHARS ×
MAX_EPISODE_CHUNKS` is dropped as a runaway backstop.

### 2.3 Staleness & freshness

- **`synced_at` is bumped on every tick**, even for byte-identical re-pushes (`index.ts:118`) — that
  bump *is* the freshness signal, and it's why the unchanged path deliberately writes **no audit row**
  (auditing every unchanged item was ~24k rows/day at 500 items).
- **Dense backlog** — `pendingItems = embeddable − embedded`; the staleness join finds items whose
  `content_sha256` moved but whose chunks still carry the old sha (`dense-index.ts:110`). `COVERAGE_FLOOR
  = 0.9` (≥90% embedded = healthy), `STALE_MS = 2h` (no embed activity + incomplete = degraded).
- **Graph staleness** — `isGraphStale` flags when nothing has projected in `GRAPH_STALE_MS = 6h`
  (`retrieval-health.ts:85`); "nothing ever projected" is *not* stale.
- **Pipeline staleness** — `STALE_MS = 3h` default with per-source overrides (`pipeline-health.ts`):
  reactive/event-driven legs (`llm`, `scan`, `pm_sync`, `dense`, `linear_inbound`, `graph_project`) are
  `null` (never age-flag; real failures surface via `ok=false`); `auth_cleanup = 26h` (24h cadence + 2h
  grace). Deleted/disabled connectors are suppressed (a frozen last-failure isn't a live break); a
  config-read failure **fails open** (suppress nothing, keep alerting).

### 2.4 Conflict resolution & attribution — human intent wins, durably

The central conflict is *"who does this content belong to?"* Derived attribution (from frontmatter /
identity resolution) can disagree with a human's deliberate correction. The resolution:

- **Correction lock** — a human correction sets `member_id_locked = true` (`attribution-correction.ts:54`).
  Once locked, the item is invisible to *every* automatic re-attribution path:
  - the unchanged-repush heal (`decideReattribution` returns `{}` — `reattribution-decision.ts:26`),
  - the bulk re-attribution engine (`reattribute.ts:62`, which *also* re-checks the flag at write time
    via `.eq("member_id_locked", false)` — closing the TOCTOU window for a correction landing mid-scan),
  - the changed-content ingest path (`member_id` dropped from the update record — `index.ts:210`).
- **TOCTOU guard on apply** — a correction re-resolves the live match set and **aborts** if the count
  differs from the previewed count, rather than touching a different set (`attribution-correction.ts:34`).
- **Heal vs. reassignment** — `null → member` is a HEAL (fill an unknown owner); `A → B` is a real
  reassignment (logged with `via: author_signal | pusher_default | correction`); a set owner is never
  auto-cleared to null.
- **AI-agent → human** — `KNOWN_AI_AGENT_NAMES` (exact, case-insensitive so a person named "Claude"
  isn't caught) rewrites arc/event participants and fact text to name the human behind
  `items.member_id`, capped at `MAX_ATTRIBUTED_HUMANS = 2` (`arc-attribution.ts`). Being named is made
  *structural* (union of humans behind cited evidence), not LLM luck.
- **Supersession semantics** — the live `items` row is **replaced in place**; `item_versions` **keeps**
  the old body/frontmatter/author; the dense chunk set is **deleted + replaced** (not versioned); the
  graph re-projects and Graphiti's temporal model supersedes the old fact (the brain stays source of
  truth, the graph is a downstream projection).

### 2.5 Crash-safety & integrity

- **PENDING_SHA sentinel** (`index.ts:190`): a brand-new item's `content_sha256` is withheld as `""`
  and committed **last**. Item write and derived-row materialization aren't one transaction, so a
  mid-materialize crash leaves the old/empty sha → the unchanged fast-path won't fire on retry → rows
  re-materialize. Self-healing.
- **Task-row validation before any item mutation** (`index.ts:172`): self-parent, missing parent, and
  parent-cycle checks run *before* the item is touched, so a 422 never leaves a half-written item/version.
- **Never-landed episode reconcile** (`lib/graph/reconcile.ts`): optimistically-recorded episodes are
  checked against Graphiti after a `GRACE_MS = 5min` window; a row whose chunks never landed is
  **deleted so the next run re-pushes** (self-healing); Graphiti unreachable this pass → left alone.
- **Single-flight** — each connector runner and the projector hold a module-level in-flight guard so a
  scheduler tick and an admin action can't duplicate work.

---

## 3. Part II — Retrieval & context composition intelligence

`retrieve()` (`lib/query/retrieve.ts:751`) dispatches to the `native` provider (default) or an
`external` one (`CONTEXT_PROVIDER`). `nativeRetrieve` runs **every independent leg in parallel** and
returns `{ sources, structured, grounded }`.

### 3.1 Query understanding (before any search)

- **Stopword + deictic stripping** — question words and temporal deictics (`latest`, `recent`,
  `today`, `now`, …) are dropped (`FTS_STOP`, `retrieve.ts:154`). Temporal words are intent, not
  content; leaving them in tanked recall under AND-semantics and poisoned the grounding signal.
- **Short-token / acronym preservation** (`isSignificantTerm`, `retrieve.ts:176`): ≥3 chars kept;
  exactly 2 chars kept **only** if it has a digit (`v2`, `s3`, `k8`) or is an all-caps acronym (`CI`,
  `QA`, `PR`, `DB`) — decided on the *original* case before lowercasing. This is the fix for eng-heavy
  channels where the load-bearing terms are short.
- **Channel scoping** (`parseChannelScope`, `retrieve.ts:243`): detects `#channel` or "in/on/from [the]
  X channel", scopes retrieval to that path segment, and strips the phrase so the channel word isn't
  also a content term. Conservative — "the sales pipeline" (no literal "channel") never scopes.
- **Conjunctive AND** (`conjunctiveTerms`, `retrieve.ts:212`): an explicit **upper-cased** `AND` is an
  opt-in precision operator ("auth AND payments" → docs about both). Only upper-case, because lowercase
  "and" is a ubiquitous stopword and treating it as conjunction would gut recall.
- **First-person + timezone** — "how about me?" resolves to the signed-in member; relative dates
  ("today" = last 24h) resolve in the asker's timezone.

### 3.2 Multi-signal retrieval (the parallel legs)

1. **Keyword FTS, ranked** (`fts-search.rankedFtsSearch`): OR of significant terms (recall bias; the
   LLM filters), ordered by `ts_rank(search, websearch_to_tsquery('english', …)) DESC, synced_at DESC`
   — so the capped window is the *best* N, not an arbitrary physical-order N. Pulls up to
   `FTS_CANDIDATE_LIMIT = 50` candidates.
2. **Dense / semantic** (`dense-search.denseSearch`): pgvector cosine kNN over `item_chunks`, one
   best chunk per item (`distinct on (item_id) … order by embedding <=> $1`). Applies a **distance
   floor** `DENSE_MAX_DISTANCE = 0.6` (~cosine 0.4) so far nearest-neighbors are excluded. Resolves to
   `[]` unless `EMBEDDINGS_URL` is set and the pgvector schema is loaded.
3. **Graph semantic expansion** (`graphExpansionQuery`): Graphiti's hybrid search returns *facts* even
   with no surface-term overlap; we harvest salient entity/fact words (≤ `MAX_EXPANSION_TERMS = 24`) and
   run a second FTS pass to reach the *source items* a literal search missed (paraphrase/synonym recall).
4. **Recency net** — newest 8 items (`synced_at DESC`), so fresh content always has a shot even when
   FTS is capped/unranked. This is why single-topic queries feel reliable.
5. **Structured extras** — always-included compact blocks (below).
6. **Graph temporal facts** — up to `GRAPH_FACTS_LIMIT = 12` Graphiti facts, tier-scoped by group id.

### 3.3 Ranking, fusion & rerank

- **RRF fusion** (`fuseByRrf`, `RRF_K = 60`): when dense contributed hits, keyword and dense rankings
  are fused by reciprocal-rank (`Σ 1/(k + rank)`); recency/augment padding scores 0; stable tie-break.
- **Cross-encoder rerank** (`rerankSources`): optional final reorder via a hosted/local reranker
  (`RERANK_MODEL = qwen3-reranker-0.6b`, `RERANK_TIMEOUT_MS = 4000`) so the most relevant source is
  cited `S1`. Best-effort — degrades to input order on any error.
- **Stable citations** — `sid`s (`S1`, `S2`, …) are reassigned on every reorder so the LLM's `[S#]`
  citations stay meaningful.

### 3.4 Deduplication on the read path

- **By item id** — one `seen` set spans FTS + recency + graph-expansion + dense, merged into a single
  id-deduped stream (`retrieve.ts:552`).
- **By path** — external-augment hits deduped separately by `path`.
- **By row_key** — recency-50 decisions vs keyword-matched older decisions.
- **Best chunk per item** — dense already collapses intra-item chunk duplicates in SQL.

### 3.5 Grounding / anti-hallucination ("stay quiet")

A specific, correct signal must exist before the answer commits — otherwise it abstains.

- **IDF specificity** (`grounding.analyzeTermSpecificity`): a term in ≤ `COMMON_FRAC = 0.15` of the
  (tier-scoped) corpus is "specific". Two flags — `specificMatching` (a rare term that actually matches)
  and `allCommon` (every term is corpus-common).
- **Decision** (`retrieve.ts:602`): `specificMatching ? grounded : allCommon ? (any FTS hit) : NOT
  grounded`. So "SSRF" grounds on a single specific hit; "what's the latest update?" falls back to
  any-hit; specific terms that match nothing → abstain instead of confabulate.
- **Dense/graph hits force grounded** — valid *only because* of the distance floor (a far neighbor,
  which every query has, would otherwise defeat the IDF safety).

### 3.6 Budgets & caps (exact)

| Constant | Value | Purpose |
|---|---|---|
| `MAX_TOTAL_CHARS` | `160_000` (~40k tokens) | Real output ceiling; merge loop `break`s when exceeded |
| `MAX_SOURCE_CHARS` | `8_000` | Per-source body truncation |
| `FTS_CANDIDATE_LIMIT` | `50` (env) | Ranked keyword candidates pulled |
| recency net | `8` | Freshness padding |
| decisions / tasks | `50` / `80` | Structured row caps |
| matched decisions | `10` | Keyword-matched older decisions |
| `DENSE_MAX_DISTANCE` | `0.6` (env) | Dense grounding floor |
| `RRF_K` | `60` | Fusion constant |
| `GRAPH_FACTS_LIMIT` | `12` (env) | Graphiti facts blended |
| `MAX_EXPANSION_TERMS` | `24` | Graph-expansion OR-terms |
| `GIT/PEOPLE_WINDOW_DAYS` | `90` | Activity-digest window |
| timeouts | graph `4s` · augment `3s` · rerank `4s` · embed `20s` | Optional-leg budgets |

### 3.7 Structured extras (survive the row caps)

- **Full-corpus task counts** (`taskStatusCounts`) — "how many open tasks?" is correct regardless of
  the 80-row detail cap.
- **Decision keyword search** (`matchingDecisions`) — an on-record decision that scrolled past the
  recency-50 window still surfaces ("which vendor did we pick in Q1?"), ranked, deduped, rendered under
  "Older decisions matching this query".
- **Supersession** — decisions render `[SUPERSEDED]` when `!still_valid`; Graphiti facts render
  `[SUPERSEDED]` when `invalid_at` is set.

### 3.8 Context shaping (spend tokens only when relevant)

The two heaviest always-on blocks — per-contributor **git-activity** and per-person **cross-tool
activity** digests — are gated by an *intent detector* (`wantsActivityContext`): they run only when the
question is about who's doing what, and only on the **team tier** (never for an external viewer). The
detector is biased inclusive (a false positive just restores the old always-on behavior).

### 3.9 Tier isolation on every read path

No RLS backstop — enforced entirely in app code, fail-closed (`isRestrictedTier` treats any non-`team`
value as restricted):

- `items` filtered on `access='external'` (FTS, dense on the *live* `items.access`, recency).
- `tasks`/`decisions` filtered on `audience='external'`.
- `graph_entities`/`graph_relationships` carry **no tier column** → **omitted entirely** for external
  principals (not filtered) to avoid leaking internal actors/commitments/reporting lines.
- Activity digests + Graphiti facts are team-tier-only / group-id-scoped.

### 3.10 Pluggability

Retrieval is a seam: `CONTEXT_PROVIDER=external` swaps the whole layer for an adapter; optional
`RETRIEVAL_AUGMENT_URL` (a GBrain/cloud retrieval service) and `RERANK_URL` blend in without touching
callers. All vendor-neutral HTTP contracts; all best-effort.

---

## 4. Part III — The Learning layer (graph → narrative arcs)

A parallel read built on the same corpus, in three layers (`docs/design/brain-learning-panel.md`):

- **Layer 1 — atomic facts**: Graphiti extracts entities + `RELATES_TO` edges from projected episodes.
- **Layer 2 — events**: attributed participants, collapsed raw evidence.
- **Layer 3 — narrative arcs**: the team LLM synthesizes 3–5 ongoing storylines from recent facts,
  cached in `arc_cache` (10-min serve-stale-while-revalidate).

Intelligence baked into arcs:

- **Projection observability** — `projection-run` maps each projector pass to an `ingest_runs` row so a
  silent stall is visible; **extraction health** compares "episodes projected" (Postgres) vs "facts
  extracted" (Neo4j) and flags *stalled* when `episodes ≥ 25 && facts == 0` (the 202-accepted-but-never-
  extracted failure that a healthcheck misses).
- **Representative sampling** — a deep fact pool (`FACT_POOL = MAX_FACTS × 20`) plus per-contributor
  round-robin **balancing** and a `PER_ITEM_CAP` so one high-volume author (or one 257k-char doc) can't
  dominate; every active contributor gets visible representation.
- **Evidence-gated credit** — a contributor reassigned *away* from an item still gets their own share /
  stays visible (evidence-gated balancing).
- **Work-time chronology** — arcs ordered by when the work happened, not extraction time; only *active*
  Linear issues (In Progress / In Review) inform arcs.
- **Resilience** — reasoning-headroom so a reasoning model doesn't starve its own output to empty; an
  **empty-clobber guard** (a transient empty synthesis never overwrites a good prior within
  `EMPTY_CLOBBER_MAX_AGE_MS = 48h`); split inline/background LLM timeouts (110s route-bound / 280s
  background) so a slow-but-healthy model doesn't false-alarm; tier redaction on evidence.
- **Corrections feed back** — an inline arc edit is folded into the prompt *and* written to Graphiti as
  a correction episode, so it persists and informs future synthesis; a re-association auto-recomputes
  arcs under a durable correction lock.

---

## 5. Part IV — Observability & health

- **`ingest_runs`** — the single ledger every leg writes to (poll, `/sync`, scan, index, project, llm).
- **Pipeline-health banner** (`getPipelineHealth`) — collapses all legs to one "is anything broken?"
  verdict on Home + Admin; suppresses deleted/disabled connectors; adds a synthetic `graph_extract` leg
  for the extraction-stall case; dismissible per exact failure signature (re-shows on a new break).
- **Retrieval-health card** (`getRetrievalHealth`) — per-leg status: answering model, keyword (always
  on), semantic (dense coverage %, pending, last-embedded), graph memory (reachability + freshness +
  extraction-stall), reranker, augment, email deliverability.
- **Edge-triggered alerts** — admins are emailed on the `ok→degraded` and `degraded→ok` edges only (one
  alert per outage, not per tick).

---

## 6. Part V — Edge-case catalog

| Edge case | How it's handled |
|---|---|
| Re-ingesting byte-identical content | `content_sha256` fast-path → unchanged branch; only `synced_at` bumps; no version/projection/embed |
| Frontmatter changed but body identical (e.g. Linear Backlog→In Progress) | Frontmatter **heal** on the unchanged path; writes only on a real change (order-insensitive `canonicalJson` compare) |
| Author signal changed without touching prose | `decideReattribution` on unchanged re-push (null→member heal, A→B reassignment) |
| Human correction vs. auto-attribution | `member_id_locked` makes every auto path skip it; re-checked at write time (TOCTOU-safe) |
| Correction preview count ≠ live match | **Abort** the correction rather than touch a different set |
| Crash mid-materialize | PENDING_SHA sentinel keeps old sha → fast-path won't fire → rows re-materialize on retry |
| Task with self-parent / missing parent / cycle | Rejected *before* any item mutation (422, no half-write) |
| Oversized item vs Graphiti extraction cap | Chunked into ≤16 episodes of ≤2500 chars each; overflow dropped as backstop |
| Undated document | Episode timestamp prefers `frontmatter.source_ts` then `synced_at`, never `now()` (won't float to top of recency-ranked arcs) |
| Tier reclassification (external→team) | Episodes deleted from the old group before re-push; old tier no longer searchable |
| Deleted source item | `deleteItemEpisodes` best-effort; a chunk the async worker never created is simply not found |
| Episode 202-accepted but never extracted | Reconcile deletes the never-landed row → next run re-pushes; extraction-health flags `episodes≥25 && facts==0` |
| Deleted / disabled integration | Pipeline-health suppresses its frozen last-failure; ingested data untouched |
| Empty / whitespace query | FTS/dense/decisions all return `[]` |
| No embeddings backend / pgvector not loaded | Dense off; install stays byte-for-byte pure-FTS |
| Embeddings provider down / quota | `embed` throws → dense catch returns `[]`; indexer counts `failed` + surfaces a sample; admin emailed on the edge |
| Graphiti unconfigured / down / malformed URL | Facts `[]`, expansion `""` → pure keyword; malformed URL treated as off (no doomed calls) |
| Reranker / augment unset or timeout | Input order / `[]` preserved |
| No significant query terms | FTS falls back to the raw question string |
| Grounding query errors | Safe default `{specificMatching:false, allCommon:true}` = old any-hit behavior |
| External principal + tier-less graph tables | Omitted entirely, not filtered (no leak) |
| Reasoning model starving arcs to empty | Reasoning headroom + empty-clobber guard keeps the prior arcs |
| Slow-but-healthy arc model | Split inline/background timeout so it doesn't record a bogus "timeout" |
| Merged meeting notes | `merged_into` tombstone set atomically; readers filter it out; re-pointed onto a path no connector syncs |
| `synced_at`/`decided_at` returned as `Date` (pg adapter) | Normalized to ISO strings throughout |

---

## 7. Part VI — The views, mapped to the data model

### Pulse (home) — `app/t/[team]/page.tsx`
The flagship narrative surface (renamed from "Home", absorbed the old "Learning" tab). Gated into
`admin-bootstrap` / `member-setup` / full view by `pickHomeState`. Full view, top → bottom:
- **Pipeline-health banner** (admins) → `getPipelineHealth` → `ingest_runs` + graph extraction + enabled `integrations`.
- **Ask bar** (`components/dashboard/ask-bar`) → a slim line that routes to the Query chat (`/query?q=…`), not an embedded hero.
- **Narrative arcs (HERO)** → `ArcsPanel` → `POST /api/brain/arcs` → `getArcs` (`arc_cache`).
- **Working on** → `components/dashboard/working-on` → `/api/dashboard/team-work` → `getCachedWorkTimeline` + `mostRecentPerPerson`
  (each person's most recent day of the SAME work-timeline the Timeline renders, via the shared `PersonWorkCard`; the old
  assignee-based `getTeamWork`/`assembleTeamWork` was repointed in #358).
- **Timeline** (collapsed disclosure) → `TimelinePanel` → `getCachedWorkTimeline` (full day → person → task → evidence).
- **Metrics** (collapsed; open for admins) → `getPulseMetrics` (KPI band / knowledge growth / usage / task funnel) + tier-scoped `decisions`.
- **Evidence trail** (collapsed) → Events/Facts feeds (`/api/brain/events`, `/api/brain/facts`).

### Query / Ask — `app/t/[team]/query/page.tsx` → `components/query-chat.tsx`, `app/api/dashboard/query/route.ts`
Streaming SSE chat. `retrieve()` fuses keyword + dense + graph + structured extras → `streamAnswer`
(`lib/query/claude.ts`, keys via `resolveAnsweringKeys`). Emits `delta` (answer), `sources` (`[S#]`
citation chips linking to `/library/[itemId]`), `done`/`error`. Grounding is a server-side abstention
signal, not a visible badge. Left rail = saved `conversations` (owner-scoped FTS). `/sync` short-circuits
to a manual sync.

### Learning — absorbed into Pulse
`app/t/[team]/learning/page.tsx` now `redirect()`s to the team Pulse home (above). Its content moved
there: **narrative arcs** (Layer 3, the hero — `POST /api/brain/arcs` → `getArcs`, cached in `arc_cache`,
inline-editable → `/api/brain/arcs/recompute`, empty state diagnosed `no_facts`/`model_failing`/
`synthesis_empty`), the **Timeline** (work-time, `getWorkTimeline` over Postgres `items` + `tasks`, day →
person → task → evidence), and **Events (Layer 2)** / **Atomic facts (Layer 1)** (`/api/brain/events`,
`/api/brain/facts`) in the Evidence-trail disclosure.

### Library / Data — `app/t/[team]/library/[itemId]/page.tsx`, `app/t/[team]/admin/data/page.tsx`
Item detail renders one `items` row (body, kind, access, SHA-256, version count, joined project/member),
tier-checked via `canSeeAccess` — the link target for arc evidence and `[S#]` citations. The Data
browser groups recent `visibleItems` by channel/path prefix (a verification view).

### Admin → Integrations — `app/t/[team]/admin/integrations/page.tsx`
- **Retrieval-health card** → `getRetrievalHealth` (dense coverage from `item_chunks` vs embeddable
  `items`; graph from Graphiti healthcheck + `graph_episodes` freshness + Neo4j fact count).
- **Recent ingestion runs** → `listRecentIngestRuns` over `ingest_runs`.
- **Answering-model indicator** → `describeAnswering`/`describeReasoning` + `usedFallback` (requested ≠
  resolved) over `teams.answering_provider` + `integrations` config presence.

### Meetings — `app/t/[team]/meetings/page.tsx`
Notes are transcript-kind `items` (team-tier); `meeting_notes` holds the metadata layer (dedup on
`source_item_id`). Action-item extraction → `tasks` pushed to Plane/Linear (marked "pushed" when
`task_pm_links` carries a provider URL).

### Codebases — `app/t/[team]/codebases/page.tsx`
`getCodebaseSummaries` (team-tier). Scans recorded as `ingest_runs source='scan'`; feeds the
git-activity digest in retrieval and the Integrations freshness suggestions.

### People / Attribution — `app/t/[team]/people/[handle]`, `app/t/[team]/admin/attribution/page.tsx`
Per-person profile + editable **member context** (personalizes retrieval/attribution). Attribution
health over `items.member_id` answers "is each stream landing on the right person?" — the foundation
under every arc/timeline surface — with a per-person drill-down to the actual items and an NL correction
box (preview → apply → lock).

### How the views interrelate
`items`/`item_chunks` are the root — browsed in Library, searched by Query, charted on Home, rolled into
the Timeline, attributed in Attribution health, and the target of every `[S#]` / arc-evidence link. The
graph (`graph_episodes` + Graphiti/`arc_cache`) powers the Pulse arcs hero; its health
shows in the Retrieval card. `ingest_runs` feeds both the Pipeline banner and the Retrieval card.
`tasks` appear in the funnel, Working On, and are the Meetings extraction target. `members`/
`items.member_id` are the attribution backbone tying arcs, timeline, and profiles together.

---

## 8. Part VII — How it was built (PR history by theme)

### A. Semantic / dense retrieval (embeddings, pgvector, RRF, rerank, distance floor)
#2 pluggable local/cloud LLM + reranker · #98 semantic retrieval via Graphiti query-expansion ·
#124 pluggable context layer + optional pgvector dense retrieval · #126 per-team embedding key ·
#211 distance floor so far neighbors don't false-ground · #229 dedicated `EMBEDDINGS_API_KEY`.

### B. Keyword/FTS + grounding + query normalization + channel scoping
#84 Slack-recall fix + parallelize retrieval · #99 "stay quiet" abstention · #100 context shaping
(intent-gated digests) · #101 completion/today-aware retrieval · #119 first-person resolution ·
#121 timezone relative dates · #180 adversarial retrieval suite · #182 keep 2-char acronyms (Gap #1) ·
#183 `ts_rank` ordering (Gap #2) · #186 IDF grounding (Gap #3) · #187 full-corpus counts + decision
keyword search (Gaps #5/#6) · #188 channel scoping (Gap #4) · #214 raise FTS candidate cap · #228
conjunctive AND · #94/#86 per-person + git activity digests · #142/#177/#178 chat FTS.

### C. Composer / caps / budgets / structured extras
#95/#93 per-member context layer · #97 recall eval harness · #128 context-layer roadmap ·
#283 background-extraction timeout · #289 distinct query vs reasoning models · #291 reasoning headroom.

### D. Graph projection + Graphiti + narrative arcs (Learning)
#77 Graphiti foundation · #82/#83 projector + blend facts into the query box · #129/#130 Layers 1–3 ·
#132 sparse-data fallback · #133 episode-size cap · #172 member→graph sync · #173/#174 no-silent-empty
+ failure logging · #176 clickable evidence · #179/#181/#185 human-grounded participants · #217
persistent arc cache (SWR) · #232 reachability probe · #281/#290/#307 arc resilience bundle · #294/#296
projector 422 diagnosis + ISO-8601 fix · #300 fail-loud + rank arcs · #301/#303/#305 extraction-cap
chunking + representative synthesis · #315 fact-pool de-noise · #330/#331/#332/#340 work-time ordering
+ timeline · #333/#342/#343 evidence-gated credit + re-association recompute.

### E. Ingestion dedup / diff-sync / freshness / attribution
#87/#88/#90/#91/#92/#102 identity unification + re-attribution (attribution backbone) · #122 scan-push
timeout · #123 `ingest_runs` log + panel · #139 commit author attribution · #155 atomic ingest + tier
isolation · #168/#171 connector-misattribution fixes · #252/#318 author-at-ingest · #337 stop
deleted/disabled integrations crying wolf · #339 reassignment propagation.

### F. Retrieval + pipeline health / observability
#189/#190 retrieval-health card + degrade/recover alerts · #263 PM-projection health · #288 percolate
silent failures · #292 augment/email health · #302 per-source staleness · #325 dismissable banner.

### G. Faceting / grouping / views
#85 Library→Data channel inspector · #135/#136 consolidated "Working On".

### Chronological narrative
It began with a pluggable LLM + reranker over Postgres-only retrieval (#2). In late June the **Graphiti
graph layer** landed (#77, #82, #83) alongside a recall **eval harness** (#97) and the **context-layer
roadmap** (#128) that framed the work as closing numbered retrieval gaps. Through July the two retrieval
halves matured in parallel — **keyword/FTS** got `ts_rank` ranking, IDF grounding, token preservation,
channel scoping, and abstention (#182–#188, #99), while **dense/pgvector** became pluggable with
per-team embedding keys, a distance floor, and a decoupled API key (#124, #126, #211, #229). The
**Learning layer** grew from Layers 1–3 (#129, #130) into a human-attributed, evidence-grounded,
cache-backed system (#176, #181, #217), then absorbed a long reliability campaign — extraction-cap
chunking, ISO-8601 timestamps, reasoning headroom, no-silent-empty (#296, #301, #305, #281, #307) — plus
ingest-time attribution that recomputes arcs on re-association (#318, #333, #339). Running through all of
it, a dedicated **observability** surface emerged (#189/#190 → #263, #288, #292, #302, #325) so degraded
embeddings, stale sources, and broken projection fail loudly instead of silently returning empty context.

---

## 9. What is intentionally *not* built yet

From `docs/design/context-layer-roadmap.md` — nothing was dropped on purpose; these are the not-yet-
reached parts of the plan:

- **First-class faceted grouping/retrieval** — facets (person, project, time, kind) exist as columns and
  drive digests, but there's no first-class facet you can group/query along in retrieval.
- **Tiered memory (working / episodic / semantic) with compress/distill** — one `items` store with
  recency-weighted retrieval; no hot/warm/cold aging, no summarization/distillation of warm memory.
- **Recall ceiling beyond the candidate cap** and **true relevance beyond lexical rank** — the job of
  dense/pgvector + a reranker at large scale (the leg exists and is grounded safely; the ceiling for a
  query matching *hundreds* of items remains).
- **Query → ingestion feedback loop** — `query_log` records queries; nothing yet routes gaps back into
  ingestion.
```
