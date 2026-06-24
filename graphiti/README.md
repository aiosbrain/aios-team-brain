# Graphiti — graph memory (experiment, alongside the existing graph/query)

Graphiti is a temporal knowledge-graph engine. We run it **locally / self-hosted** (it never
mixes into the TS codebase — the brain calls its REST API). It sits **downstream of the brain**:
the brain's connectors fill `items`/`tasks`/`decisions`; `lib/graph` *projects* those rows into
Graphiti as episodes; a tier-scoped query endpoint searches it. This is a parallel path next to
the existing `graph_entities`/`graph_relationships` + `/api/v1/query` — not a replacement.

## Run it
```bash
cd graphiti
cp .env.example .env        # set OPENAI_API_KEY (or OPENAI_BASE_URL for a local model) + NEO4J_PASSWORD
docker compose up -d --wait
# REST:    http://localhost:8000  (Swagger at /docs, health at /healthcheck)
# Neo4j:   http://localhost:7474  (browser)
```
Then point the brain at it: `GRAPHITI_URL=http://localhost:8000` in the brain's env.

## REST surface the brain uses (verified against getzep/graphiti)
- `POST /messages` — add episodes: `{ group_id, messages: [{ content, timestamp, source_description, name, role_type }] }` (async, 202).
- `POST /search` — `{ query, group_ids, max_facts }` → facts (graph edges) with temporal validity + source.

## Tiering (must hold — see CLAUDE.md §5)
Graphiti has no tier awareness, so we **encode team+tier into `group_id`** (`<teamSlug>:team` /
`<teamSlug>:external`). The query endpoint only searches the group_ids a viewer's tier may see.
See `lib/graph/group.ts`.

## LLM note
Extraction quality depends on structured-output support. Start with a strong cloud model; a local
model (Ollama via `OPENAI_BASE_URL`) trades quality/speed for privacy — swap via env, no code change.

## Status
Phase 1: Slack transcripts → episodes, one team, bounded backfill. Validate the graph before
wiring Linear/Plane (those land in the brain via other work; the projector reads them downstream).
