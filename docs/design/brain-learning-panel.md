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

**Layer 3 — narrative arcs:** gather the 7-day node+edge substrate (Cypher), send to Claude with the
arc-synthesis prompt, cache 10 min. Arcs = `{id, title, confidence, summary, participants, sources}`.

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
  *Mitigate (our side, since we can't patch their image):* `lib/graph/project.ts` caps episode content
  at `MAX_EPISODE_CHARS` (6000) so extraction output stays under the limit; full item text still lives
  in `items`/pgvector/FTS. Only a few outlier docs are truncated (median item ~240 chars). If the worker
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
