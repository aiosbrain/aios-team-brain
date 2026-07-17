# Graphiti — graph memory (experiment, alongside the existing graph/query)

Graphiti is a temporal knowledge-graph engine. We run it **locally / self-hosted** (it never
mixes into the TS codebase — the brain calls its REST API). It sits **downstream of the brain**:
the brain's connectors fill `items` (ALL ingestions: Slack transcripts, deliverables, decisions,
tasks, artifacts); `lib/graph` *projects* those rows into Graphiti as episodes; the standalone
`/api/v1/graph-query` endpoint searches it, AND `lib/query/retrieve` blends Graphiti's temporal
facts into the main AI query box's context (tier-scoped, best-effort). Graphiti complements the
existing `graph_entities`/`graph_relationships` digest — not a replacement.

## Run it
```bash
cd graphiti
cp .env.example .env        # set OPENAI_API_KEY (or OPENAI_BASE_URL for a local model) + NEO4J_PASSWORD
docker compose up -d --wait
# REST:    http://localhost:8000  (Swagger at /docs, health at /healthcheck)
# Neo4j:   http://localhost:7474  (browser)
```
Then point the brain at it: `GRAPHITI_URL=http://localhost:8000` in the brain's env.

## REST surface the brain uses (verified live 2026-06-24 against getzep/graphiti)
- `POST /messages` — add episodes: `{ group_id, messages: [{ content, timestamp, source_description, name, role_type, role }] }` (async, 202). **`role` is required** (nullable) — omitting it → 422. The async worker is serial (~10-20s/episode via gpt-4o) and **dies silently on any non-Cancelled exception** (e.g. an invalid `group_id`), so validate before posting.
- `POST /search` — `{ query, group_ids, max_facts }` → facts (graph edges) with temporal validity + source.

## Tiering (must hold — see CLAUDE.md §5)
Graphiti has no tier awareness, so we **encode team+tier into `group_id`** (`<teamSlug>_team` /
`<teamSlug>_external`). Graphiti's `validate_group_id` permits only `[A-Za-z0-9_-]` — a `:` separator
is rejected — so we join with `_`. The query endpoint only searches the group_ids a viewer's tier
may see. See `lib/graph/group.ts`.

## Projection trigger (the on-ramp)
`lib/graph/project` only *defines* the projection; `lib/graph/run` (`runGraphProjection`) drives it.
Two callers: the admin **"Project to graph"** button on the Integrations page (on-demand) and
`lib/graph/scheduler` (an interval poller registered in `instrumentation.ts`). Both are inert
unless `GRAPHITI_URL` is set. Tune with `GRAPH_PROJECT_MINUTES` (default 60), `GRAPH_PROJECT_LIMIT`
(default 500 items/run), `GRAPH_PROJECT_ENABLED=false` to disable, and `GRAPH_MAX_EPISODE_CHARS`
(default **4000**) — the per-episode content cap. A bigger episode extracts more nodes → larger
structured output; the extractor's output ceiling is raised to 16384 by the patched image (see
`Dockerfile` + the "202 ≠ extracted" gotcha in `docs/ARCHITECTURE.md`). The cap was lowered 6000→4000
because a dense 6000-char episode's structured output could still overflow even the 16384 ceiling and
silently kill getzep's (per-job-exception-less) ingest worker. A malformed `GRAPH_MAX_EPISODE_CHARS`
(empty/non-numeric/≤0) falls back to 4000 rather than blanking projection.

## LLM note
Extraction quality depends on structured-output support. Start with a strong cloud model; a local
model (Ollama via `OPENAI_BASE_URL`) trades quality/speed for privacy — swap via env, no code change.

## Status
Phase 2: ALL content-bearing item kinds (transcript/deliverable/decision/task/artifact) → episodes,
projected on a schedule, and blended into the main query box. Bounded per run (`GRAPH_PROJECT_LIMIT`);
a backlog beyond one run still needs cursor pagination. Earlier: Phase 1 was Slack transcripts only. Validate the graph before
wiring Linear/Plane (those land in the brain via other work; the projector reads them downstream).
