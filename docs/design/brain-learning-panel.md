# "What the Brain is Learning" — architecture

A read/write context-visualization panel in the AIOS dashboard, sourced from the **Graphiti**
temporal knowledge graph, rendered as three stacked layers that ladder up:

- **Layer 1 — Atomic facts:** recently extracted facts (last 24h), typed + source-attributed.
- **Layer 2 — Events:** those facts grouped by the **event** (episode) that produced them, with
  participants.
- **Layer 3 — Narrative arcs:** LLM-synthesized storylines across the last ~7 days — editable,
  with human corrections written back to the graph so future synthesis improves.

Layer 3 is the point; Layers 1–2 are the substrate. The design principle: **the grain is the
extracted fact; facts are grouped by the event that produced them; arcs cluster events into
storylines.** Everything is event-anchored so it composes upward.

---

## Why direct Neo4j (not the REST server)

We run `zepai/graphiti` (getzep's FastAPI over Neo4j). Its read surface is only:
`POST /search` (fact edges for a query), `GET /episodes/{group_id}?last_n` (recent episodes),
`POST /get-memory`. There is **no** "recent nodes/edges by time, by type, in a window" query. The
panel's Layer 1 (recent typed facts) and Layer 3 (all nodes+edges in 7d) can't be built on that.

**Decision: read the Graphiti Neo4j graph directly via Cypher** (add `neo4j-driver`, a read-only
client `lib/graph/neo4j.ts`). We keep using REST `/messages` for writes (projection is unchanged)
and `/search` where a query fits. This is the "architect it properly" path — richest and exact —
at the cost of coupling to Graphiti's graph schema (see Risks).

### Graphiti's Neo4j schema we depend on
- `(:Episodic {uuid, name, content, source, source_description, created_at, valid_at, group_id})`
  — the episodes we project. **`name = "items:<item_id>"`** → this is our `source_event_id`: it maps
  every episode back to a brain `items` row (for the real source icon + participants + link).
- `(:Entity {uuid, name, summary, created_at, group_id, labels})` — extracted entities (people,
  projects, systems…). `labels`/type → the Layer-1 type badge.
- `(:Episodic)-[:MENTIONS]->(:Entity)` — which entities an event mentions → **participants** (when
  the entity is a person we can reconcile to `members`).
- `(:Entity)-[r:RELATES_TO {uuid, fact, created_at, valid_at, invalid_at, group_id, episodes}]->(:Entity)`
  — **facts** (edges). `r.episodes` lists the source episode uuids → this is how we group facts by event.

### Tier safety (SOLE enforcement — CLAUDE.md §5)
Graphiti has no tier awareness; tier is encoded in `group_id` (`<teamSlug>_team` / `<teamSlug>_external`,
see `lib/graph/group`). **Every Cypher query MUST filter `WHERE x.group_id IN $visibleGroups`** where
`$visibleGroups = visibleGroupIds(teamSlug, viewerTier)`. This is the only thing stopping an
`external` viewer seeing team facts — guarded by a data-mechanics isolation test.

---

## Layer → query mapping

**Layer 1 — atomic facts (last 24h, limit 15):**
```cypher
MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
WHERE r.group_id IN $groups AND r.created_at >= $since24h
RETURN r.uuid AS id, r.fact AS fact, r.created_at AS at,
       labels(a) AS a_labels, b.name AS b_name, r.episodes AS episode_uuids
ORDER BY r.created_at DESC LIMIT 15
```
Type badge ← entity labels / a small classifier on the edge; source ← the source episode's `source`.

**Layer 2 — events (episodes in window, with facts + participants):**
```cypher
MATCH (ep:Episodic) WHERE ep.group_id IN $groups AND ep.created_at >= $since
OPTIONAL MATCH (ep)-[:MENTIONS]->(p:Entity)
OPTIONAL MATCH (x)-[r:RELATES_TO]->(y) WHERE ep.uuid IN r.episodes
RETURN ep.uuid, ep.name, ep.source, ep.source_description, ep.created_at,
       collect(DISTINCT p.name) AS participants, collect(DISTINCT r.fact) AS facts
ORDER BY ep.created_at DESC
```
`ep.name = "items:<id>"` → join to `items`/`members` for the real source icon, avatars, and a link
into the library. This is the ladder rung Layer 3 consumes.

**Layer 3 — narrative arcs:** gather the recent fact substrate (Cypher), send to Claude with the
arc-synthesis prompt, cache 4h. Arcs = `{id, title, confidence, summary, participants, sources}`.

**Fair representation (why a contributor's varied work must not vanish).** Synthesis feeds the model a
bounded set of `MAX_FACTS` facts. Getting that set right is the whole game — a contributor invisible in
the input is invisible in the arcs. Four safeguards, all in `lib/graph/arcs.ts` unless noted:

- **De-noise at the source** (`lib/graph/learning.ts` `recentFacts`): Graphiti records entity-dedup as
  `RELATES_TO {name:'IS_DUPLICATE_OF'}` edges ("_x_ is a duplicate of _x_") and leaves superseded edges
  in the graph stamped `expired_at`. Both carry fresh `created_at`, so they flood a newest-first read
  (measured ~26% + ~8% of one team's edges). A shared `FACT_NOISE_FILTER` is ANDed onto BOTH graph
  reads (Layer 1 `recentFacts` and Layer 2 `recentEvents`' fact-lists), so no layer surfaces the noise.
- **Deep pool, not the newest slice** (`FACT_POOL`): fetch far more than `MAX_FACTS`, because the
  newest-N is dominated by whoever extracted the most recently — others fall off the cliff *before*
  balancing runs.
- **Two-level balance — contributor → item** (`balanceFacts`): round-robin across contributors so a
  high-volume person can't crowd out a low-volume one, AND within each contributor round-robin across
  their source items (capped at `PER_ITEM_CAP`) so one huge document (a 257k-char `ARCHITECTURE.md`
  extracted into 159 facts) can't BE its author's entire share and bury their real varied work.
- **Request arcs ∝ contributors + split distinct threads** (`arcsRequested`, `buildSystemPrompt`): the
  requested arc count scales with the number of distinct contributors in the balanced set (not a flat
  ceiling), and the prompt tells the model to split ONE person's distinct workstreams into separate arcs
  rather than merging them.

Note attribution vs. narrative: a fact is attributed to the item's `member_id` (its author), which is
correct for authorship but means a big reference doc's facts describe the *system*, not the author's
*work* — the per-item cap blunts this; a fuller fix (down-weighting reference docs; ingesting per-PR
narrative rather than thin per-commit facts) is the follow-up substrate work.

---

## Components to build

- **`lib/graph/neo4j.ts`** — read-only Neo4j client (bolt, pooled). All Cypher lives here; every query
  takes `visibleGroups`. Best-effort: returns [] if `NEO4J_URL` unset or unreachable (panel degrades).
- **`lib/graph/learning.ts`** — `recentFacts()`, `recentEvents()`, `narrativeArcs()` — compose the
  Cypher + reconcile episode `items:<id>` back to `items`/`members` for source + participants.
- **API routes** (session-auth, tier from the caller):
  - `GET /api/brain/facts` → Layer 1
  - `GET /api/brain/events` → Layer 2
  - `POST /api/brain/arcs` → Layer 3 (synthesize, cached) · `POST /api/brain/arcs/recompute` (with corrections)
- **`app/t/[team]/learning/page.tsx` + `components/learning/*`** — the three-layer panel (spec's UI:
  type badges, event cards with stacked avatars, editable arc summaries, recompute banner).
- **Correction writeback:** when an arc summary is edited + recomputed, persist the correction so it
  informs future synthesis. **Decision:** write it as a **correction episode via `POST /messages`**
  (`name: "correction:<arc_id>"`, `source_description: "human correction"`) — keeps Graphiti the sole
  writer of its own graph and lets it participate in future retrieval. (Alternative: direct Cypher
  `CREATE (:Correction)` — more literal to the spec, but bypasses Graphiti's model; deferred.)

---

## Integration with the dense/vector store (pgvector)

The pgvector dense-retrieval DB and the Graphiti graph are **two indexes over the same `items`**,
serving different jobs — they complement, not compete:

- **pgvector** = semantic *passage* retrieval (find the right text to answer a question). It already
  powers the Q&A box: `lib/query/retrieve` fuses dense (pgvector) + FTS + Graphiti facts via RRF.
- **Graphiti** = entity/relationship/*temporal structure* (who/what/when). It powers this panel's
  facts → events → arcs.

Every ingested item is BOTH chunked+embedded into `item_chunks` AND projected as a Graphiti episode →
entities/edges. So: **graph = the skeleton (structure + time); vector = the flesh (semantic evidence).**

Where the vector store plugs into this panel (mostly Layer 3):
- **Layer 3 arc grounding** — when Claude synthesizes an arc, pull the most semantically-relevant item
  passages (dense retrieval) as supporting evidence, so arc summaries cite real text, not just graph
  edges. Makes arcs concrete instead of abstract.
- **Fact/event enrichment** — link a fact or event to its nearest items (dense) as "supporting sources".
- **Search the panel** — "show arcs/events about X" uses dense retrieval to find relevant events.

Layers 1–2 stay graph-native (structure); the vector store enters at Layer 3 (evidence/grounding) and
any search affordance. No new plumbing — both already read from the same `items`.

## Phasing
1. **Neo4j read client + tier isolation test** (the foundation; prove group_id filtering blocks
   cross-tier reads on a real Graphiti-populated Neo4j).
2. **Layer 1** (facts feed) end-to-end: client → `/api/brain/facts` → panel, auto-refresh 60s.
3. **Layer 2** (events) — episodes + participants reconciled to `members`.
4. **Layer 3** (arcs) — synthesis + cache; then inline edit + recompute + correction writeback.

## Human attribution for AI-agent participants (added 2026-07-08, extended 2026-07-08)

A recognized AI-agent/tool name (e.g. "Claude Code", "AIOS Team Brain", "Claude Agent SDK" —
mentioned in a Slack message or PR body, not a real actor) could stand in a narrative arc as if it
were the person who did the work, with no way to trace it to a human. Every ingested item already
carries a real attribution (`items.member_id` → `members`, excluding connector service-accounts —
see `lib/ingest/run.ts`'s `resolveConnectorAuth`/`is_connector`), so `getArcs`/`recomputeArcs`
(`lib/graph/arcs.ts`) resolve it in **two places**, not one:

1. **The synthesis PROMPT (input)** — before calling the LLM, every numbered fact `[F12] …` fed to
   the arc-synthesis prompt is attributed with the human behind its source item
   (`attributedFactTexts` in `lib/graph/arc-attribution.ts`, pure):
   - AI-agent subject → `"(Chetan Nandakumar, via Claude Code) Claude Code refactored the auth module"`;
   - **any other subject with a resolvable human** → `"(Chetan Nandakumar) the checklist evaluator was added"`;
   - subject that already names the human (first-name → full-name) → left as-is (no `"(Chetan Nandakumar) Chetan shipped X"` redundancy, via `subjectNamesAHuman`);
   - no resolvable human and not an agent → unchanged.

   **This is the fix (2026-07-10) for arcs with no person's name** — e.g. "Context-Management System
   Enhancements" or "Deterministic Checklist Evaluator", whose facts have technical/component subjects.
   Previously only AI-agent-subject facts were attributed, so those arcs reached synthesis with no
   human at all and rendered nameless; now the human (always known via `items.member_id`) is surfaced
   into the prompt regardless of the subject's shape, so the summary is grounded in a person from the
   start rather than only patching the arc's `participants` after the fact.
2. **The arc OUTPUT (`participants`)** — `attributeParticipants` still rewrites a recognized AI-agent
   participant name to `"Claude Code (Chetan Nandakumar)"`, or `"Claude Code (unattributed AI agent)"`
   when no human resolves, as a backstop in case the LLM still echoes a bare agent name into
   `participants` despite the grounded prompt.

Both steps resolve humans from a batched Postgres query, `resolveHumanActorsByItem`
(`lib/graph/human-actors.ts`, shared with the Layer 2 fix below) — one `items → members` round trip
for every item id touched by a `getArcs`/`recomputeArcs` call (not one query per fact and another per
arc), returning an `item id → human` map that both `attributedFactTexts` (prompt) and the
`participants` rewrite (output) read from in-memory. `resolveHumanActors` (a thin wrapper returning
the deduped name list) is kept for callers that only need that shape.

**Latency trade-off:** the fact-resolution step must complete BEFORE the LLM call now (the prompt
depends on it), so `resolveEpisodeItems` + `resolveHumanActorsByItem` can no longer run in
`Promise.all` alongside `callLLMRaw` the way they used to. This adds one sequential Postgres round
trip to every `getArcs`/`recomputeArcs` call — accepted as the cost of a synthesis input that's
grounded in a human instead of raw tool-name prose.

**Layer 2 (added 2026-07-08):** `GET /api/brain/events`'s `participants` had the same gap — raw
`MENTIONS` entity names from Graphiti's own extractor, unattributed. Since one event maps to exactly
ONE source item (unlike an arc's multiple evidence items), the fix is simpler: `resolveHumanActorsByItem`
resolves every event's `itemId` in one batched query, and `attributeEventParticipants`
(`lib/graph/arc-attribution.ts`) rewrites `participants` the same way `attributeParticipants` does for
arcs. Layer 1's `subject`/`object` fields have the same characteristic (raw extracted entity names)
but are not currently displayed as if they were actors, so they're left unattributed for now.

**Learning page layout (added 2026-07-08):** narrative arcs (Layer 3) are the synthesized payoff and
stay expanded at the top of `app/t/[team]/learning/page.tsx`; events and atomic facts (Layers 1–2) —
the raw evidence trail underneath — are collapsed by default behind a single `<details>` disclosure
("Recent activity — events & atomic facts"), the same native-element pattern already used for an
arc's evidence list (`components/learning/arcs-panel.tsx`). Rationale: an arc's own clickable evidence
links are the primary "verify this" path; the full unfiltered Layer 1/2 feed is there for the rare
deeper dive, not as permanently-stacked primary UI.

## Arc cache — persistent + serve-stale-while-revalidate (added 2026-07-10)

Arc synthesis is an LLM call over the last 7d of the graph — expensive, and identical for everyone
sharing a tier-visible group set. It was cached **in memory for 10 min** (`lib/graph/arcs.ts`), which
meant: lost on every deploy/restart, not shared across instances, and the first request after each
expiry blocked on the LLM. Now there's a two-tier cache:

- **`arc_cache` Postgres table** `(team_id, group_key, arcs jsonb, computed_at)` — `group_key` is the
  sorted `visibleGroupIds(tier)` set (so a row is inherently tier-scoped; an `external` viewer only
  ever touches the external-group row). Sole writer: `lib/graph/arc-cache` via `lib/graph/arcs`.
  Regenerable — safe to truncate. `arcs` is written with an explicit `JSON.stringify` because the pg
  adapter only auto-casts non-array *objects* to jsonb; a top-level array would otherwise bind as a
  Postgres array literal (`invalid input syntax for type json`).
- **`getArcs` read path is serve-stale-while-revalidate:** (1) fresh in-memory (this process) → return
  instantly; (2) Postgres `arc_cache` — fresh (< 4h) → return; **stale → return the stale arcs
  immediately AND kick off a fire-and-forget recompute** (in-flight-deduped via a module `Set`, so N
  concurrent stale reads fire ONE LLM call), using its own `adminClient` so it doesn't depend on the
  request's client lifecycle; (3) cold miss → compute inline, persist to both caches. `recomputeArcs`
  (the human-correction path) always recomputes and writes both caches.

**Why SWR over a timer-driven global refresh** (the other option considered): a scheduler that
recomputes every team's arcs on an interval would fire LLM calls for teams nobody is looking at (a
cost multiplier) and would need each team's provider keys available in the background. SWR only ever
recomputes a team **that is actually being viewed**, still gives warm reads (the viewer sees the
previous arcs instantly while the refresh runs behind them), and needs no background key access. The
one tradeoff: the arcs a viewer sees can be up to one refresh-cycle stale — fine for a 7-day-window,
4h-TTL summary that is explicitly "as of" a timestamp, not real-time. If proactive warming is ever
wanted (e.g. a nightly warm for the whole org), the timer variant is recorded as a follow-up in
`docs/TODO.md`. This runs on a persistent Node server (the in-process ingest scheduler already relies
on that), so the fire-and-forget promise is not at risk of serverless request-teardown.

## Risks & mitigations
- **Schema coupling** — we depend on Graphiti's internal Neo4j labels/props, which can change across
  Graphiti versions. *Mitigate:* pin the `zepai/graphiti` image tag; isolate ALL Cypher in
  `lib/graph/neo4j.ts`; an integration test against a real populated Neo4j catches breakage on upgrade.
- **Ops** — the brain now needs a Neo4j bolt connection (new env `NEO4J_URL`/`NEO4J_USER`/`NEO4J_PASSWORD`
  on the aios-team-brain service; internal to the AIOS Railway project). Read-only credentials preferred.
- **Extraction lag** — Graphiti's async worker is ~10–20s/episode and serial; "last 24h" facts lag
  ingestion. The panel should show "as of" and not imply real-time.
- **getzep worker dies on any job exception (root cause of the stalls)** — `graph_service/routers/ingest.py`'s
  `AsyncWorker.worker()` loop catches only `asyncio.CancelledError`, so ANY other exception from
  `add_episode` permanently kills the worker and freezes the whole ingest queue (silent — the HTTP API
  keeps 202-ing). The trigger seen twice in prod (2026-06-25, 2026-07-03) is a large episode whose
  entity/edge extraction overflows the LLM output-token cap (`Output length exceeded max tokens 8192`).
  *Mitigate (our side, since we can't patch their image):* `lib/graph/project.ts` **chunks** a large
  item into ≤`GRAPH_MAX_EPISODE_CHUNKS` (16) episodes of ≤`GRAPH_CHUNK_CHARS` (2500) chars each
  (superseded the old single-episode truncation cap in #305 — chunking preserves all content instead of
  losing it), so each chunk's extraction output stays under the limit; full item text still lives in
  `items`/pgvector/FTS. Median item ~240 chars = a single chunk. If the worker
  ever wedges anyway, restart graphiti (it's an image-based service; the Custom Start Command below persists).
- **Graphiti start command (Railway)** — the `zepai/graphiti:latest` image declares a non-root `USER app`
  but its default CMD launches via `uv` at `/root/.local/bin/uv`, which `app` can't exec once Railway
  runs the container as the declared user (it broke on a 2026-07-03 restart). Fix = a **Custom Start
  Command** on the graphiti service that (a) base64-injects an `except Exception: continue` into the
  worker loop of `graph_service/routers/ingest.py` (the resilience patch above — applied at boot, since
  we can't edit the image), then (b) `exec /app/.venv/bin/uvicorn graph_service.main:app --host 0.0.0.0
  --port 8000` (runs uvicorn straight from the venv, no `uv`). It always falls through to launching
  uvicorn even if the patch no-ops, and persists across restarts/redeploys. **Do not reset it to plain
  uvicorn** — that reintroduces the worker-death wedge.
- **Sparse/stale graph (soft window)** — Graphiti's extractor can stall silently (it did in prod on
  2026-06-25, leaving ~200 pushed-but-unextracted episodes; newest graph fact was weeks old). With a
  hard time cutoff every layer then renders blank and the panel looks broken. *Mitigate:* the
  `sinceISO` window in `lib/graph/learning.ts` is a **soft preference** — when the windowed query
  returns nothing, `recentFacts`/`recentEvents` retry without the time bound and surface the
  most-recent-N regardless of age (arcs inherit this via `recentFacts`). The `group_id` tier filter
  is **never** dropped in the fallback — only the time bound — so tier isolation still holds
  (proven in `test/graph-neo4j-tier.test.ts`). This is a display safety net, **not** a substitute for
  fixing the upstream extractor stall.
- **Fallback** — if direct Neo4j proves unviable in prod, Layer 2 can fall back to `GET /episodes` +
  `items`/`graph_episodes` (event = item, participants = `member_id`), and Layer 1 to `/search`; Layer 3
  synthesis is unaffected. Kept as the degrade path, not the primary.

**Arc eligibility (Layer 3 only).** Not all graph facts inform arcs. A Linear issue informs arcs only while it's ACTIVE work — gated on the canonical Linear workflow-state `type` (`started`; persisted as `frontmatter.state_type`), with the display-name regex (`ARCS_LINEAR_ACTIVE_STATE_RE`, default `progress|review`) as fallback for rows ingested before `state_type`. Backlog/Todo/Done/Canceled — and the terse `kind:"task"` board mirror (`issues.md`, which carries no state) — stay in the graph + facts panel as context but are filtered from the arc substrate at synthesis (`lib/graph/arc-eligibility`). A fact dedup'd across sources is kept if ANY of its items is eligible (a Done ticket co-cited with a meeting stays). Non-Linear content is unaffected.
