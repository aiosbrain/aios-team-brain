# Phase C — per-project graph projection & migration (design)

**Status:** design, pre-code. Governs the Phase C graph slices (spec `project-context-classification-v1.md` §6 / §17-C). `AIOS-Work: PCCC-2`.
**Gate:** this doc exists because the work touches schema + LLM extraction cost + multiple surfaces (CLAUDE.md task gate) — it must pass a Fable cold-read plan review before any code slice starts.

## 1. Problem

The Graphiti graph is partitioned by **tier** today: an item's episodes live in `<teamSlug>_team` or `<teamSlug>_external` (`lib/graph/group.episodeGroupId`), and a reader searches `visibleGroupIds(tier)`. That is the ONLY graph isolation (no RLS).

Phase B enforced the **item** reads (items/retrieval/timeline/arcs) at project grain, but it could not enforce the **graph** legs: the graph mirrors are tier-partitioned, not project-partitioned, so a member restricted out of project P would still get P's *facts* from the tier graph. Slice PCCB-2 handled this by **OMITTING the graph legs entirely for any attenuated/partitioned principal under enforcing** (§5.8b). That is safe but lossy — an enforcing team loses graph-grounded Q&A and graph-derived arcs for every non-full-visibility member.

**Phase C re-enables those legs by partitioning the graph per project**, so a principal searches exactly the project graphs the oracle says they can see — the graph inherits the item store's partition model. PCCC-1 already landed the key-scheme foundation (`projectGroupId`, `graphGroupIdsForVisibleProjects`); this doc is the projection + read + migration that makes it live.

## 2. Decision

### 2.1 Schema — `graph_episodes` identity widens to per-(item, group)

Today `unique (team_id, source_table, source_id)` — **one ledger row per item**, holding its single tier `group_id` plus the chunk-diff / pending-delete state. An item projected into N project graphs needs **N rows**. The identity becomes `unique (team_id, source_table, source_id, group_id)` (the `(content_hash, project_id)` extraction cache §6 asks for, modulo the key). The chunk-diff (`chunk_shas`/`chunk_config`), `pending_delete_group_id`/`pending_delete_at`, and `episode_uuid` stay **per row** — they are already per-(item, group) in meaning; only the key was too narrow. Additive migration: `alter table … add` nothing (the columns exist); the change is the **unique index** + backfill of the composite key. The single-writer guard (`lib/graph/project` only) is unchanged.

**Falsifier:** if any consumer reads `graph_episodes` assuming one-row-per-item (grep `source_id` selects that don't group by `group_id`), the widening breaks it — enumerate them before the migration.

### 2.2 Projector — fan-out into each tagged project's graph

`projectItemsToGraph` computes one `episodeGroupId(teamSlug, item.access)` today. Under Phase C it resolves the item's **active include memberships** (`project_context_memberships` → the same set the inspector/enforce read) → `projectGroupId(teamId, projectId)` per project, and projects the item's episodes into **each** project graph, each with its own per-row ledger + chunk-diff. General (the Everyone-visible project) is one of those partitions.

- **Content-hash cache (the cost floor):** the per-(item, group) row's `chunk_shas` mean a re-tag into a partition whose `(content_sha, group_id)` already extracted is a **zero-LLM** cache hit; only the FIRST tag into a partition pays extraction. Graphiti has no cross-group fact copy, and copying facts across graphs would launder provenance, so first-tag-pays is intrinsic.
- **Laziness for cold projects:** extraction into a project with no reader is deferred to a **pending projection row**, not an LLM call; the first query/view of that project arms it; `classification_mode='off'` projects never extract. This is what keeps P̄ from multiplying spend for projects nobody reads.
- **Retire/reconcile:** the `retireEpisodesForItems` / `reconcileProjectedEpisodes` / `pending_delete_group_id` machinery already operates per group_id — it fans over the item's now-multiple rows unchanged in shape.

### 2.3 Read cutover — search the project graphs, re-enable the omitted legs

`lib/query/retrieve` graph legs + `lib/graph/arcs` synthesis switch from `visibleGroupIds(tier)` to `graphGroupIdsForVisibleProjects(teamId, oracleVisibleProjectIds)` for an enforcing principal. This **re-enables** the legs PCCB-2 omitted — now they are partition-filtered, so an attenuated principal gets exactly their project graphs. The tier-scoped path stays for permissive teams (unchanged today's behavior) until the tier scheme is retired (2.5).

**The cutover is gated, not flipped:** a leg is re-enabled for a principal only once every project in their visible set has a **ready** project graph (backfill complete for those projects). Until then the leg stays omitted for that principal — the migration never reintroduces the §5.8b leak, because "omit" is the safe state we are migrating *from*.

### 2.4 Migration / backfill — dual-write, then gated cutover, then retire

Sequenced so no step is a leak or an unbounded cost spike:

1. **Schema widening** (2.1) — additive, no behavior change.
2. **Projector dual-write** — the projector writes BOTH the tier group (as today) AND the project groups (new). During this phase reads still use the tier path; the project graphs populate on each item's next projection tick. Doubles projection cost for *newly projected* items only (the cache makes re-syncs of unchanged content free).
3. **Backfill** — re-project existing items into their project graphs. This is a **priced one-time re-extraction** (see §3) and is the expensive step; it is throttled through the existing projector batch/`GRAPH_REQUEUE_MAX_PER_PASS` budget and is **lazy where possible** (a cold project's backfill defers until armed).
4. **Read cutover** (2.3) — per-principal, gated on backfill-ready.
5. **Retire the tier groups** — once reads no longer use them, delete `<teamSlug>_team/_external` (per team) via the existing `deleteItemEpisodes` path, and drop the dual-write.

**Falsifier:** if the dual-write's projection-cost doubling (step 2) over a real week exceeds the budget ceiling, or the backfill (step 3) prices above an acceptable one-time spend, the strategy must change (e.g. lazy-only backfill, no eager re-projection). Both are measured before committing, not assumed.

## 3. Cost model — measured, not smoothed

Spec §6 baseline (prod `llm_usage source=graph`, trailing 7d as of 2026-08-07): **$87.97/week, ~$0.151 & ~101 calls/episode**, over 583 newly-projected episodes — but that window includes the AIO-798 repo-import backfill, so the steady-state per-episode constant is likely lower. **This design re-reads the baseline from `llm_usage` over a QUIET window (no backfill) before any multiplier decision** — the number above is not trusted as-is.

- **Steady-state multiplier:** cost ≈ baseline × (1 + share_multi × (P̄multi − 1)), P̄ = mean partitions/item (General counts). Expected steady state P̄ ≈ 1 + (share classified into an initiative) → approaching ~2 (~$760/mo at the measured rate) only if the whole corpus classifies. The levers that hold it below that: `exclusive` container rules, restriction-moves-not-copies, no-widening, laziness.
- **One-time backfill:** re-extracting the existing corpus into project partitions. For scale, the CHUNKCAP eager-invalidation comparison priced ~5,166 episodes ≈ $76 — the full re-projection is bounded by (existing episodes × mean new partitions) and is **estimated from the real episode count before scheduling**, then run throttled. If the estimate is unacceptable, backfill goes lazy-only (re-project on next re-sync / on arm).
- **Per-project visibility:** extend `llm_usage` metering with `meta.group_id` (the graph proxy `lib/llm/graph-proxy` already tags calls) → the cost dashboard's graph row gains a per-project breakdown; a per-project soft cap is configuration on top of the existing per-team ceiling.

## 4. Non-goals / deferred

- **FalkorDB migration** — the §17-C "spike = exit gate" is already resolved (evaluated: stay on Neo4j/Graphiti for now; a server upgrade + a rewrite of the direct bolt reads, saves RAM not LLM spend, SSPL licensing). Phase C proceeds on the existing backend.
- **The Postgres `graph_entities`/`graph_relationships` mirrors** (the `/api/v1/query` structured legs, distinct from Graphiti facts) — those gain their own `group_id` column in the same spirit but are a separate leg; scoped as a follow-up, not this doc.
- **Per-project arcs** (arc synthesis per project graph) — depends on the projector + read here landing first; separate slice.

## 5. Sequencing (each a code slice, each its own PR + review)

`PCCC-3` schema widening (unique key) + the graph_episodes consumer audit · `PCCC-4` projector fan-out + dual-write + laziness · `PCCC-5` backfill (priced, throttled, lazy-where-cold) · `PCCC-6` read cutover (retrieve + arcs, gated) · `PCCC-7` retire the tier groups + drop dual-write. The cost re-measurement (§3) is a gate BETWEEN PCCC-4 and PCCC-5 — the backfill does not schedule until the quiet-window baseline and the one-time estimate are in hand.

## 6. What would falsify the whole approach

1. The quiet-window baseline shows per-episode cost materially above the §6 figure → the P̄ multiplier makes per-project extraction unaffordable → fall back to General-only graph + item-level enforcement for the graph legs (keep them omitted for attenuated principals, accept the UX loss).
2. The one-time backfill estimate is unacceptable → lazy-only backfill (no eager re-projection); reads stay omitted for un-migrated projects longer.
3. A `graph_episodes` consumer depends on one-row-per-item in a way the widening can't preserve → the schema decision (2.1) needs rework before anything downstream.
