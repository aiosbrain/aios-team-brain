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
- `POST /messages` — add episodes: `{ group_id, messages: [{ content, timestamp, source_description, name, role_type, role }] }` (async, 202). **`role` is required** (nullable) — omitting it → 422. The async worker is serial (~10-20s/episode via gpt-4o). Upstream it **dies silently on any non-Cancelled exception** (e.g. an invalid `group_id`) — our image fixes that (PATCH 6 below), but keep validating before posting: a dropped episode still costs a reconcile round-trip.
- `POST /search` — `{ query, group_ids, max_facts }` → facts (graph edges) with temporal validity + source.

## Tiering (must hold — see CLAUDE.md §5)
Graphiti has no tier awareness, so we **encode team+tier into `group_id`**, minted as
`<teamSlug>_team` / `<teamSlug>_external`. Graphiti's `validate_group_id` permits only
`[A-Za-z0-9_-]` — a `:` separator is rejected — so we join with `_`. The query endpoint only
searches the group_ids a viewer's tier may see.

**That mint is a starting value, not an address.** The id a team's graph actually lives under is
STORED in `projects.graph_group_id` on the two built-in projects, and it is IMMUTABLE — so after a
team slug rename it stays frozen under the OLD slug while the team's slug is new. Readers must
therefore resolve `lib/graph/tier-groups.visibleTierGroupIds` (the pointer) and never re-spell the
id from the live slug: doing so names a group nothing has ever written to, and the surface goes
permanently empty with no error and every diagnostic still green. See the "graph group id is READ
FROM THE POINTER" invariant in `docs/ARCHITECTURE.md`. `lib/graph/group.ts` holds the mint;
`lib/graph/tier-groups.ts` holds the resolution.

## Projection trigger (the on-ramp)
`lib/graph/project` only *defines* the projection; `lib/graph/run` (`runGraphProjection`) drives it.
Two callers: the admin **"Project to graph"** button on the Integrations page (on-demand) and
`lib/graph/scheduler` (an interval poller registered in `instrumentation.ts`). Both are inert
unless `GRAPHITI_URL` is set. Tune with `GRAPH_PROJECT_MINUTES` (default 60), `GRAPH_PROJECT_LIMIT`
(default 500 items/run), `GRAPH_PROJECT_ENABLED=false` to disable, and the episode-sizing knobs
`GRAPH_CHUNK_CHARS` (default 2500) / `GRAPH_MAX_EPISODE_CHUNKS` (default 16). A large item is split into
≤16 chunks of ≤2500 chars, each projected as its own episode (`items:<id>#k`), so every chunk's
extraction output stays under Graphiti's ceiling (16384, native in graphiti-core 0.29.3 and asserted
by the build — see `Dockerfile`, whose ⚠️ start-command note is a deploy precondition, + the
"202 ≠ extracted" gotcha in `docs/ARCHITECTURE.md`). Chunking replaced the old single-episode char cap:
truncating to fit LOSES content, whereas chunking preserves all of it. A malformed value
(empty/non-numeric/≤0/fractional) falls back to the default rather than emitting empty/garbage episodes.

## LLM note
Extraction quality depends on structured-output support. Start with a strong cloud model; a local
model (Ollama via `OPENAI_BASE_URL`) trades quality/speed for privacy — swap via env, no code change.

**Two models, both configurable.** `MODEL_NAME` is the strong model; **`GRAPHITI_SMALL_MODEL`** is
the high-volume half (dedupe/summary, routed by the image's PATCH 2). The small one used to be
welded into the image as `gpt-4.1-nano`; it now reads from the environment and DEFAULTS to
`gpt-4.1-nano`, so a deployment that sets nothing is byte-identical to before. Two things to know
before changing it, both verified rather than assumed:

- ⚠️ **Through the proxy you should not set it at all.** When `OPENAI_BASE_URL` points at the
  brain's LLM proxy, the image sends the sentinel **`aios-small`** and the brain picks the real
  model (Admin → Integrations). `aios-small` is not a model and never will be — it names the
  request's *intent*, so it is invariant under pricing decisions and there is nothing to keep in
  sync. This replaces the old rule that `GRAPHITI_SMALL_MODEL` had to *equal*
  `GRAPHITI_SMALL_MODEL_MARKER` in the brain: that made two separately-deployed services
  independently responsible for remembering one string, and it failed silently (every call fell
  back to the strong model, nothing errored, the only symptom was a bill). Matching env vars only
  ever worked where both processes shared an environment — on Railway the app and graphiti are
  separate services with separate variable scopes. An explicit real model still overrides the
  sentinel; an explicit `aios-small` is ignored outside the canonical proxy route so it cannot be
  sent to a provider. The brain still accepts the legacy marker, so an unmigrated image works.
- ⚠️ **A reasoning model needs output headroom.** At `max_tokens=900` a reasoning model spends the
  whole budget on its trace and returns `content=None`, surfacing as `EmptyResponseError` after all
  four tenacity retries. Safe here only because `DEFAULT_MAX_TOKENS` is 16384, which the build
  asserts — don't lower it while a reasoning model is configured.

Changing the model affects FUTURE calls only; the existing graph is untouched and nothing is
re-extracted.

## Image patches
The `Dockerfile` vendors a handful of edits into `graphiti-core` / `graph_service`, each **anchored
by a build-time assert** so a base-image or library bump fails the BUILD rather than silently
shipping an image that looks patched and isn't. Read the block comment above each one; the two most
recently added:

- **PATCH 5 — `additionalProperties: false` on the `json_schema` response format**
  (`patch-strict-schema.py`). `_build_response_format` sends a non-strict schema, which OpenAI and
  Azure **intermittently** reject (`'additionalProperties' is required to be supplied and to be
  false`). Intermittently because OpenRouter routes per request, so the identical schema passes and
  fails minutes apart — it cannot be diagnosed by retrying. It fails in the worst available shape:
  `POST /messages` still returns 202, so the brain records a successful push and the graph just
  stays empty. Recognise it by episode count climbing with `yield: 0.00 entities/episode`. Hardening
  is a no-op for lenient providers, so the working path cannot regress. Graphiti's own `json_object`
  fallback was tried first and is worse — without constrained decoding the model returns the
  injected schema instead of an instance.
- **PATCH 6 — one bad episode must not kill the queue** (`patch-resilient-worker.py`). The
  AsyncWorker catches only `CancelledError`; anything else ends the asyncio task with nothing
  logged, and `/messages` keeps returning 202 forever while processing nothing. That is how PATCH
  5's 400 took a whole 91-episode queue down. PATCH 5 removes that trigger; this removes the
  amplifier, which is the more valuable half. The `print` also moves after `queue.get()` — printing
  before the await is what made a dead worker read as a busy one. A dropped episode is re-pushed by
  `lib/graph/reconcile.ts`, so nothing is lost permanently.

## Status
Phase 2: ALL content-bearing item kinds (transcript/deliverable/decision/task/artifact) → episodes,
projected on a schedule, and blended into the main query box. Bounded per run (`GRAPH_PROJECT_LIMIT`);
a backlog beyond one run still needs cursor pagination. Earlier: Phase 1 was Slack transcripts only. Validate the graph before
wiring Linear/Plane (those land in the brain via other work; the projector reads them downstream).
