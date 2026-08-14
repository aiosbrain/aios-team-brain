# Phase C — per-project graph projection & migration (design)

**Status:** design, pre-code, **revised after Fable plan review** (2 Blockers + 5 Highs folded). Governs the Phase C graph slices (spec `project-context-classification-v1.md` §6 / §17-C). `AIOS-Work: PCCC-2`.
**Gate:** touches schema + LLM extraction cost + multiple surfaces (CLAUDE.md task gate) — reviewed as a plan before any code slice starts. This revision must clear a second plan-review pass before PCCC-3 opens.

## 1. Problem

The Graphiti graph is partitioned by **tier**: an item's episodes live in `<teamSlug>_team` or `<teamSlug>_external` (`lib/graph/project.projectItemsToGraph` → `episodeGroupId(teamSlug, item.access)`), and a reader searches `visibleGroupIds(tier)`. That write-time `item.access` split is the ONLY graph isolation (no RLS).

Phase B enforced the **item** reads at project grain but could not enforce the **graph** legs — the mirrors are tier-partitioned, not project-partitioned. PCCB-2 handled it by **OMITTING the graph legs for any attenuated/partitioned principal under enforcing** (§5.8b): safe but lossy. Phase C re-enables them by partitioning the graph per project (PCCC-1 landed the key scheme `projectGroupId`/`graphGroupIdsForVisibleProjects`).

## 2. Decision

### 2.0 Scope correction from review — TWO invariants the first draft dropped

- **Tier isolation is NOT subsumed by project partitioning (plan review High 3).** `project_context_memberships` is orthogonal to `items.access`: an initiative project can hold BOTH team- and external-access items, and Graphiti search has no per-fact filter (the whole §5.8b motivation). So a project graph is tier-MIXED. An external-tier principal visible to project P via the External built-in would otherwise read team-tier facts from P's graph. **Decision: Phase C re-enables the per-project graph legs for TEAM-TIER principals only. External-tier principals KEEP the omit path** (as today) — they are a minority (client/consultant collaborators), team-tier principals `canSeeAccess` every access level so a tier-mixed project graph is safe *for them*, and this avoids doubling every partition into `(project, tier)`. Retiring the `_external` tier group (§2.4 step 5) is therefore explicitly OUT of Phase C — the External tier graph stays until a later phase gives external principals a tier-safe per-project read. `projectGroupId` stays tier-free; the tier axis lives in the READ (external → omit), not the key.
- **The content-hash cache must key on `(content_sha, group_id)`, and it does not today (plan review Blocker 1 / attack 4).** The projector's ledger read is `.eq("source_id", item.id).maybeSingle()` (`project.ts:616-622`) — one row per item — and this adapter's `maybeSingle` returns `rows[0]` SILENTLY on multiple rows (`lib/db/pg/query-builder.ts:336`). So the moment fan-out writes a second row, the projector reads an arbitrary group's ledger; a sha-match against the wrong group SKIPS extraction into a group that never got the content → a **silently-empty project graph**. The per-`(item, group)` ledger read is therefore not an optimization — it is the correctness precondition, and it lands in the SAME slice as the schema.

### 2.1 Schema + projector conflict-target — ONE coupled slice (was "additive"; it is not)

The unique key widens `(team_id, source_table, source_id)` → `+ group_id`. This is **NOT additive** — both projector upserts conflict on the OLD 3-column key (`project.ts:661,893`, emitted verbatim as `ON CONFLICT (…)`), and Postgres requires a unique index exactly matching the conflict target. So there is no ordering where a schema-only slice is a no-op. **The coupled change (PCCC-3):**

1. In `postgres/migrations/`: `create unique index … (team_id, source_table, source_id, group_id)`, then `alter table graph_episodes drop constraint <auto-named narrow unique>` (the narrow unique is inline in `create table` at `schema.sql:2382`, so editing `schema.sql` is a no-op on prod — the drop MUST be a migration; mirror the final shape into `schema.sql` for from-zero).
2. In the SAME PR: both projector `onConflict` → the 4-column key, AND the ledger read → `.eq("source_id", item.id).eq("group_id", groupId).maybeSingle()` (per-group), AND the change-detection (§2.2).
3. **Railway deploy-ordering window (named, not assumed):** code deploys on merge; `pg:schema` runs as the preDeploy hook BEFORE the release goes live, so the wide index exists before the new code serves — but confirm the preDeploy ordering holds for an index+drop migration (the guard is that a release halts if preDeploy fails). No dual-write in this slice — the projector still computes ONE group per item (the current tier group) but through the widened key, so it is behavior-preserving.

**Consumer audit (PCCC-3, by name):** every `graph_episodes` reader that assumes one-row-per-item — the projector ledger read (above), `extraction-health.ts:362` (`count(*) … as team episode count`), `retrieval-health.ts:143`, `lib/metrics/graph-efficiency.ts:24` ("a row is one ITEM"). Under fan-out these inflate by P̄; each is fixed to group-by or count-distinct-item as appropriate in this slice.

### 2.2 Projector — fan-out with change DETECTION as a set diff (net-new, leak-critical)

Under fan-out the projector resolves the item's **active include memberships** (`project_context_memberships` — the same set enforce/inspect read) → `projectGroupId` per project (team-tier items only reach initiative/General graphs; see §2.0), and reconciles the item's episodes into EACH project graph, each with its own per-`(item, group)` ledger row.

The current detection is a single compare `tierChanged = existingRow.group_id !== groupId` (`project.ts:668`). Per-project it is a **SET DIFF** over the item's group rows: *added* (new membership → full push, paying extraction), *retained* (unchanged content → sha cache hit, free), *removed* (**untag** — isolation-critical). The removed side is **net-new machinery** (plan review High 6): untagging an item from project P must set `pending_delete_group_id` on P's row and purge P's graph of that item — "restriction-moves-not-copies" is the leak-by-construction rule this enforces, and nothing existing detects membership-removal (reconcile's orphan repair covers item-gone only, `reconcile.ts:141`). This is scoped as real work, NOT "unchanged in shape."

- **Content-hash cache (per `(content_sha, group_id)`):** a re-tag/re-sync of unchanged content into a partition whose row already extracted is a zero-LLM hit; a FIRST tag into a partition pays. **Honest correction (plan review Medium 9):** because untag purges and retires the row (isolation, above), a later re-tag into that same project RE-PAYS — the cache hit is real only for unchanged content re-syncing within a *persisting* membership, not "re-tag is always free."
- **Laziness + arming (resolves the readiness circularity, plan review High 5):** extraction into a project with no reader is deferred to a **pending projection row** (net-new state — §2.5). It is armed **as a side effect of a read**: when a team-tier principal queries, their oracle-visible projects are scheduled for extraction, and the graph leg stays OMITTED for that principal until those projects' rows are reconcile-confirmed landed. So the first query arms-and-omits; later queries get the leg. No circularity — the query is the arming trigger, not a separate readiness handshake.

### 2.3 Read cutover — team-tier principals search their project graphs

`lib/query/retrieve` graph legs + `lib/graph/arcs` switch, FOR A TEAM-TIER ENFORCING PRINCIPAL, from `visibleGroupIds(tier)` to `graphGroupIdsForVisibleProjects(teamId, oracleVisibleProjectIds)` — but only over projects whose graph is **landed** (§2.2 arming); an un-landed project keeps the leg omitted for that principal. External-tier principals and permissive teams are unchanged (external stays omitted; permissive keeps the tier path). **Readiness is a concrete per-`(item, group)` state**, not "backfill complete" hand-waving: a project is read-ready for a principal when its membership set has landed rows (reconcile-confirmed, since 202 ≠ extracted). Computing it per request is a bounded aggregate over the principal's visible-project rows; if it proves hot, it caches on the same visibility-hash the timeline variant uses.

### 2.4 Migration — General is REMAPPED, not re-extracted; dual-write is deferral-gated

The first draft's "dual-write doubles cost for newly-projected items only" is false (plan review Blocker 2): `runGraphProjection` rescans the WHOLE corpus from an undefined cursor every pass (`run.ts:125`), and every item is in General, so a naive fan-out re-extracts the entire corpus into General on the first pass — an immediate unthrottled spike that also trips the Graphiti queue-wedge (`reconcile.ts:35`). Corrected sequence:

1. **PCCC-3** — coupled schema + per-group ledger + consumer audit (§2.1). Behavior-preserving.
2. **PCCC-4 — General REMAP, not re-extract.** Today's `<teamSlug>_team` graph already IS the team's General content (General = Everyone-visible team content ≈ what the team tier held). So the General partition is populated by a **ledger + Graphiti group RENAME/remap** where possible, not re-extraction — the biggest partition (every item) costs ~0 LLM. (If Graphiti has no group-rename, the fallback is a metadata remap of `graph_episodes.group_id` for the General rows + leaving the facts in place under the old group id, i.e. General's group id = the existing team group id for a transition. Feasibility of an in-place group-id change is a PCCC-4 spike, priced before commit.)
3. **PCCC-5 — initiative fan-out, deferral-gated, with a REAL push budget.** Fan-out into initiative projects is where genuine new extraction happens (P̄−1 per classified item). It ships behind a projector-side **push budget** — a NEW cap (the cited `GRAPH_REQUEUE_MAX_PER_PASS` is reconcile's re-queue budget, `reconcile.ts:81`, NOT a projector push cap) — and behind arming (§2.2), so cold initiatives never extract. The cost gate (§3) sits BEFORE this slice and is real: nothing schedules initiative fan-out until the quiet-window baseline + the priced estimate are in hand.
4. **PCCC-6 — read cutover** (§2.3), team-tier only, per-project-landed gated.
5. **PCCC-7 — cleanup:** invalidate tier-keyed `arc_cache` rows (`group_key` = sorted tier-group set, `schema.sql:2397`) so stale synthesized arcs don't outlive their groups. Retiring the `_external` group stays OUT of Phase C (§2.0).

**Concurrency (plan review Medium 11):** any backfill/remap runs THROUGH the in-process `runGraphProjection` single-flight (`run.ts:73`) or takes a DB advisory lock — never as a separate script racing the hourly runner (duplicate episodes, since `addEpisodes` never overwrites by name).

### 2.5 Net-new state this design introduces (was implicit)

- A **per-`(item, group)` ledger** (the widened key) — the correctness substrate.
- **Untag detection + purge** (§2.2 removed-side) — leak-critical.
- A **deferred/pending projection** state distinct from reconcile's `content_sha256 = ''` sentinel, which already means three things (re-queued / redacted / retired). A deferred row must NOT be deleted by reconcile's landed-check (`reconcile.ts:312` deletes never-landed rows past the grace) — it needs its own flag + a reconcile exemption. Under-specced in the first draft; scoped here.
- A projector **push budget** (§2.4 step 3) — new, distinct from the reconcile re-queue budget.

## 3. Cost model — re-measured, backfill priced at the CURRENT rate

The first draft juxtaposed two per-episode rates 10× apart (plan review High 7): the §6 measured $0.151/episode vs the CHUNKCAP $0.0147/episode anchor — different model/routing eras. **Neither is trusted:** re-measure per-`(episode, partition)` cost from `llm_usage source=graph` over a QUIET window (no backfill) before PCCC-5 schedules. Then:

- **Steady state:** cost ≈ baseline × (1 + share_multi × (P̄multi − 1)); dual-write of a classified item is (1 + P̄)×, not 2×. General is remapped (~0), so the marginal cost is initiative fan-out only.
- **One-time backfill = initiative fan-out only** (General is remapped, §2.4). Priced from the REAL count of (items classified into an initiative) × current per-episode rate, throttled through the push budget, lazy for cold initiatives — estimated before scheduling; if unacceptable, lazy-only (fan out on next re-sync / on arm, no eager backfill).
- **Per-project cost visibility (plan review High 4 — the metering claim was false):** the graph proxy CANNOT attribute per-call group (Graphiti's completion calls carry no episode context — `graph-proxy.ts:92`; per-call attribution needs an upstream graphiti_core change). So per-project spend is **APPROXIMATED** from the per-`(item, group)` episode count in `graph_episodes` (episodes-per-project as a cost proxy), not exact `llm_usage` attribution. The per-team ceiling stays the only HARD cap; a per-project soft cap is a later item contingent on the upstream change.

## 4. Non-goals / deferred

- **FalkorDB** — §17-C spike resolved (stay on Neo4j/Graphiti; a server upgrade + bolt-read rewrite, saves RAM not LLM spend, SSPL). Phase C proceeds on the existing backend.
- **External-tier per-project graph reads** — external principals keep the omit path (§2.0); a tier-safe per-project external read is a later phase.
- **The Postgres `graph_entities`/`graph_relationships` mirrors** (`/api/v1/query` structured legs) — a separate `group_id` leg, follow-up.
- **Per-project arcs** — depends on the projector + read here landing; separate slice.

## 5. Sequencing

`PCCC-3` coupled schema + per-group ledger + set-diff detection + consumer audit · `PCCC-4` General remap (+ feasibility spike) · **[cost re-measure gate]** · `PCCC-5` initiative fan-out (deferral-gated, push-budgeted, priced) · `PCCC-6` read cutover (team-tier, per-project-landed) · `PCCC-7` arc_cache invalidation + cleanup. Each its own PR + Fable/Codex review.

## 6. Falsifiers

1. Quiet-window per-episode cost materially above §6 → P̄ multiplier unaffordable → keep the graph legs omitted for attenuated principals (accept the UX loss), General-only graph.
2. General cannot be remapped (no in-place group-id change; §2.4 step 2 spike fails) → General also re-extracts → the backfill is the FULL corpus cost, likely unacceptable → lazy-only.
3. A `graph_episodes` consumer depends on one-row-per-item in a way the widening can't preserve → §2.1 reworks before anything downstream.
4. Untag-purge (§2.2) proves unreliable (a removed membership leaves facts in P's graph) → restriction is not leak-safe → the whole re-enable is blocked; legs stay omitted.
