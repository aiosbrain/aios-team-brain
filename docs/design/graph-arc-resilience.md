# Narrative-graph & arc resilience (2026-07 incident)

## What happened
The Learning page's narrative-arcs panel went blank. The scary first hypotheses — the graph was
**wiped** or **rename-orphaned** — were **disproven by live prod** (via the Railway CLI + in-container
probes): Neo4j held **4,130 nodes / 956 episodes / 10,747 facts** under the correct current
`group_id`s (`aios_team`), fully reachable. No data was lost. There were two *independent* problems:

### Problem 1 — empty arcs (the visible symptom): reasoning-model token starvation
- On 2026-07-13 an OpenRouter provider was configured with model `qwen/qwen3.7-plus` (a **reasoning**
  model). #268 routes all generation through `lib/llm/complete.ts`, OpenRouter taking precedence.
- Reasoning models spend the `max_tokens` budget on **hidden reasoning before any answer**. Arc
  synthesis passed `maxTokens: 2048`; a live test of the real key+model showed the model burning
  hundreds of reasoning tokens first, so the large arc prompt returned **empty/truncated content**.
- `complete.ts` returned `""` → `parseArcsJson` failed → `[]` → and the empty result was **cached**,
  pinning the page blank for hours. Same failure silently hit every generation path #268 re-routed.

### Problem 2 — the graph stopped updating (separate): projector 422
- `graph_episodes.max(projected_at)` was stuck at 2026-07-09; projector logs showed
  `graphiti POST /messages → 422` every tick. No new episodes since. The pre-July-9 data remained,
  which is why *reads* weren't empty.
- Follow-up finding: a **minimal** `/messages` POST now returns **202** — so this is **payload-specific**
  (a particular episode's content/field, or the reconcile re-push), NOT a blanket API-contract break.
  Isolating the exact rejected payload is deferred to the separate Graphiti-side fix.

## Fixes shipped in this PR
1. **`lib/llm/complete.ts` — reasoning headroom + loud failure.** Send `maxTokens + REASONING_HEADROOM_TOKENS`
   (default 6000, env-overridable) on the OpenAI-compatible/OpenRouter path — you're billed only for
   tokens generated, so it's free for non-reasoning models and unbreaks reasoning ones. Empty content
   now throws **naming `finish_reason`** (the starvation signature) instead of a bare "empty".
2. **`lib/graph/arcs.ts` — an empty synthesis never clobbers a good cache** (`commitArcs`). One bad LLM
   call can no longer pin the panel empty; a stale-but-real arc set is kept and retried on next view.
3. **`lib/graph/arcs.ts` — arcs are no longer time-boxed.** Dropped the hard 7-day window; synthesize
   from the most-recent `MAX_FACTS` regardless of age (a quiet week / stalled projector can't blank it).
4. **Health card — graph *freshness*, not just reachability.** `deriveGraphState` now reads **degraded**
   when the projector hasn't written in > 6h even if `/healthcheck` is green — the exact blind spot that
   let Problem 2 hide behind a green "Graph: on". The card shows episode count + last-projected and a
   distinct "projector stalled" banner (vs "unreachable").
5. **Projector observability.** Each scheduler tick with a signal records a `graph_project` run to
   `ingest_runs` (`lib/graph/projection-run.ts`), so a silently-failing projector (the 422) surfaces in
   Admin → Integrations → Recent ingestion runs instead of only ephemeral logs.

## Deferred (separate work)
- **Problem 2 root cause** — isolate the payload that 422s (reconcile re-push vs a specific field), then
  fix Graphiti-side. Now observable via #5 + the freshness card.
- **Neo4j durability guard.** The wipe hypothesis was wrong (the volume clearly persists — 956 episodes
  survived), but the repo still doesn't *guard* the prod Neo4j volume config. Low urgency; documented so
  a future detached-volume can't silently wipe undetected. The graph is fully regenerable from Postgres
  (clear `graph_episodes` → re-project) as a recovery path.
- **Email alert on graph degrade** — mirror the dense-leg edge alert once the freshness signal has soaked.
