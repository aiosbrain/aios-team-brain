# Design: narrative arcs as a precomputed context layer

**Status:** proposal · **Author:** (handoff from the Learning-timeout investigation, 2026-07-21)

## Problem

Narrative arcs are currently generated **on the read path**. `getArcs` (`lib/graph/arcs.ts`) is
serve-stale-while-revalidate: it reads the `arc_cache` table, and on a cold/stale entry it fires the
arc-synthesis LLM call **during the page request**. That call is expensive (clusters ~200 graph facts
into storylines). Consequences observed in prod:

- **The read path is coupled to model latency + health.** A slow model (a reasoning model spends ~80s
  chain-of-thinking over 200 facts) hits the route's ~120s `maxDuration` and aborts → the Learning
  page shows a timeout banner instead of arcs. A model outage/quota-429 does the same.
- **Latency forces quality compromises.** Because the call must fit a ~110s request budget, we're
  pushed to turn reasoning off / cap facts / cap tokens *to beat the clock* — decisions that should be
  about arc *quality*, not request timeouts.
- **Every viewer can pay the cost.** SWR means the first viewer after a cache expiry triggers the
  synthesis inline; a busy morning re-pays it repeatedly.

This violates our data-architecture principle: **compute a derived fact once, at the lowest shared
layer, and let every surface read it identically.** Arcs are already consumed by more than the
Learning page — the Social Brain discovers opportunities from them (`lib/social/discover-arcs.ts`) —
so on-demand-per-reader synthesis is the wrong shape.

## Principle

Arcs should be a **precomputed layer** exactly like the other derived layers:

| Layer | Produced by | Read by |
|---|---|---|
| atomic facts / events | Graphiti extractor (background) | Learning page (pure read) |
| embeddings | dense-index job (background, `content_sha256`-idempotent) | retrieve (pure read) |
| graph projection | projector scheduler (background) | facts/events reads |
| **narrative arcs** | **← today: synthesized lazily on read (SWR)** | Learning page, Social Brain |

The fix: move arc synthesis to a **scheduled background job**, and make every reader a **pure read of
`arc_cache`** — no LLM in the request path.

## Design

1. **Arc-synthesis scheduler** (`lib/graph/arc-scheduler.ts`, mirroring `lib/graph/scheduler.ts`):
   - On the same cadence as the graph projector (or shortly after each projector tick, since arcs are
     downstream of facts), regenerate arcs **per team that has recent graph activity**. Skip idle
     teams so we don't spend LLM budget re-clustering an unchanged graph — gate on "newest fact
     `created_at` > `arc_cache.computed_at`" (nothing new → skip).
   - Writes through the existing `commitArcs` single-writer → `arc_cache` (durable, already there).
     `commitArcs` already keeps the last-good arcs on an empty/failed synthesis and has a staleness
     bound — so a bad run never blanks the layer.
   - Records the outcome to `ingest_runs` (source `llm`, task `arcs`) — already wired — so the
     answering-model health leg on the dashboard reflects background health, not per-request luck.

2. **`getArcs` becomes a pure read.** Drop the inline synthesis from the request path; the Learning
   API and Social Brain just `readArcCache`. Optionally keep a **cold-start** inline synthesis only
   when the cache has *never* been populated for a team (first load before the first scheduled run),
   guarded so it's a one-time event, not steady-state.

3. **The user "recompute with correction" path stays synchronous.** That's an explicit, user-initiated
   action (`recomputeArcs`) — it's fine for it to run inline and show a spinner; it's not a page load.

## What this buys

- **Instant Learning page** — a DB read, never an 80s LLM call. No timeout banner from a slow model.
- **Decoupled from model health** — a model outage/quota/latency spike degrades the *next background
  refresh*, not the page; the last-good arcs keep serving (already true via `commitArcs`).
- **Latency-free quality tuning** — reasoning on/off, fact count, token budget become pure **quality**
  knobs with no ~120s request ceiling. (Note: current evidence says arcs are *better* reasoning-OFF —
  faster AND better participant attribution — so this isn't hypothetical headroom we need, but it
  removes the constraint either way.)
- **One computation, many surfaces** — Learning + Social Brain read the same precomputed arcs.

## Migration

`arc_cache` already exists and `commitArcs` already guards it — so this is additive:
1. Add the scheduler (small; mirror `lib/graph/scheduler.ts` + `startGraphScheduler()` wiring in
   `instrumentation.ts`), gated on `GRAPHITI_URL`/graph activity.
2. Make `getArcs` read-only (keep cold-start fallback behind a one-shot guard).
3. Spec-first tests: (a) the scheduler skips a team whose graph hasn't changed since `computed_at`;
   (b) a failed background run leaves the prior arcs intact (already covered by `arcs-commit` tests);
   (c) `getArcs` performs no LLM call when the cache is warm.

## Interaction with the current model work

Independent of this, the answering-model routing is under active change (query vs reasoning model,
`reasoningActive`). This design makes that work *easier*: once arcs are off the read path, the model
choice for arcs is a background-cost/quality decision, not a page-blocking timeout risk — so the team
can pick the best arc model freely. Current data favors the non-reasoning path for arcs (equal-or-
better arcs, participants attributed, ~8× faster).
