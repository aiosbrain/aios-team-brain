# Context Layer — vision vs. reality, and the roadmap

The original context-layer design (the "grain extraction → indexed across facets → tiered memory →
composer → query" diagram) was broader than what's built today. This doc reconciles the two so we
know **what exists, what's partial, and what was never started**, and lays out a concrete plan to
close the gaps. Grounded in the code as of 2026-07-02.

## Original vision (the diagram)
Ingestion → **grain extraction** (typed, timestamped units) → **indexed across** Temporal /
Semantic / Entity / Signal-type / Actor → **three-tier memory** (Working `hot 7–30d` · Episodic
`warm 1–12mo` · Semantic `cold permanent`) with **compress/distill** aging → **context-window
composer** (rank · dedup · suppress-stale · budget) → **query interface** (NL → intent → retrieval
→ cited) with a **feedback loop**.

## Vision vs. reality

| Diagram element | Status | In the code today |
|---|---|---|
| Ingestion layer | ✅ built | Slack/Plane/Linear/GitHub connectors + sidecar (notion/gdrive/confluence/web/granola) → `items` (single-writer `lib/ingest`) |
| Grain extraction (typed, timestamped) | 🟡 partial | `items` typed by `kind` + `synced_at`; `tasks`/`decisions` extracted to typed tables; Graphiti extracts entities/edges. Item-grained, not atomic-fact-grained |
| Semantic index (embeddings) | ✅ built (just) | pgvector `item_chunks` + HNSW + RRF fusion (`lib/query/dense-search`) |
| Temporal / Entity / Signal / Actor indexes | 🟡 partial | Facets exist as columns (`synced_at`/`updated_at`, `member_id`, `project_id`, `kind`, `tasks.sprint`); retrieval **digests** slice by contributor / person / task-status. **No first-class facet you can group or query along.** |
| Three-tier memory (working/episodic/semantic + compress/distill) | ❌ not built | One `items` store, recency-weighted retrieval. No hot/warm/cold, no aging, no compression/distillation. **No `tier`/`temperature` anywhere.** |
| Context-window composer (rank · dedup · suppress-stale · budget) | ✅ mostly | `lib/query/retrieve`: RRF rank (+ optional rerank), dedup by id/path, ~40k-token budget, `still_valid`/SUPERSEDED flags (stale-suppression partial) |
| Query interface (NL → intent → retrieval → cited) | ✅ mostly | `/api/*/query` → retrieve → Claude with `[S#]` citations. "Intent parse" is light (term extraction + graph expansion + activity heuristic) |
| Feedback loop | 🟡 partial | `query_log` records queries; no query→ingestion loop yet |

**Bottom line:** the horizontal spine (ingest → typed units → keyword+semantic+graph retrieval →
composed, cited answer) is built. The two distinctive pieces still missing are **(A) first-class
faceted grouping** and **(B) tiered memory with aging**. Nothing was dropped on purpose — these were
just the not-yet-reached parts of the plan.

---

## The plan (three steps, increasing ambition)

### Step 1 — Grouping surface / "the viz" ← STARTING HERE
Make the grouping the data *already supports* visible: a dashboard view that groups recent context by
**entity (person/project), event/time, and signal type**, using existing columns (`member_id`,
`project_id`, `synced_at`, `kind`) + Graphiti entities. Read-only over current data.

- **Why first:** highest visibility, no schema change, and it validates the grouping model before we
  promote it into retrieval (Step 2).
- **Approach:** a read module (e.g. `lib/context/groups.ts`) that buckets recent `items` by a chosen
  facet + a dashboard page (`app/t/[team]/…`) rendering the groups. Tier-gated through the existing
  `visibleItems` choke-point (no `external` leak). Graphiti supplies entity clusters.
- **Effort:** small–medium. **Risk:** low (read-only, no new tables).

### Step 2 — First-class faceted grouping/retrieval
Promote grouping into the query path: detect facet intent ("what's happening in sprint X", "everything
about <person/project>") and group/scope retrieval along that facet, not just free-text.

- **Approach:** `lib/query/facets.ts` — resolve entities against the roster/projects, parse time
  windows + kinds, then filter/group the dense+FTS candidates by facet before the composer. Reuses
  existing columns; Graphiti facts drive entity grouping. Optional materialized facet index only if
  perf demands it at scale.
- **Effort:** medium. **Risk:** medium (touches `retrieve`; guard tier-safety + add data-mechanics
  tests for each facet).

### Step 3 — Tiered memory (working / episodic / semantic) with compress/distill
The big architectural piece and the one truly not started.

- **Approach (phased):**
  1. **Classify, don't move** — a derived `memoryTier(item)` (by age + `kind` + status): working =
     recent/open, episodic = completed/closed within N months, semantic = canonical (ADRs,
     `still_valid` decisions, principles). No physical move; retrieval weights/scopes by tier.
  2. **Compress** — a background job summarizes episodic clusters into compact digest items
     (LLM summarization), so warm memory stays cheap to retrieve. (gbrain's "dream cycle" is the
     reference pattern.)
  3. **Distill** — promote stable, repeatedly-referenced facts into semantic (canonical) items.
- **Effort:** large (needs a scheduled job + retrieval changes + new state). **Risk:** medium–high
  (correctness of aging/promotion; guard against dropping still-relevant context).

## Sequencing
**Step 1 (viz) → Step 2 (faceted retrieval) → Step 3 (tiered memory).** They're a natural
progression: the viz is the read-side of faceting; Step 2 makes it a retrieval capability; Step 3
adds the temporal-memory dimension on top. Each step is independently shippable and useful.
