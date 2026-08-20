---
access: team
---

# TICKFIT-2 — the graph projector's batched ledger read (re-scoped at design review: the candidate-predicate draft was DECLINED)

## 0. What and why

**What:** the projector's per-item `graph_episodes` probe — one sequential DB round trip per
item, 2,826 per run — becomes ONE batched read per existing 500-item page (~6 round trips
per run). Nothing else about the projector changes: same rows, same per-row decisions, same
counters, same observability. Plus the per-leg timing meta both TICKFIT slices named as the
missing instrumentation, so the follow-up decision is measured, not guessed.

**Why (measured, prod, 2026-08-20):** `graph_project` runs 56×/48h at **10.5 min avg (max
11.4, dead stable)**, scanning ~2,826 eligible items to project ~0 (`skipped == scanned`
exactly — 100% no-op traversal). The scout traced the whole duration to the per-row probe
(`lib/graph/project.ts:824-829`): 2,826 × ~220 ms ≈ 10.4 min; there is NO per-row Graphiti
call on the steady-state path, and the CPU terms (chunk+hash) are O(corpus bytes) ≈ seconds.

**Why THIS shape (the design round's DECLINE, folded):** the first draft proposed a
candidate predicate (the slice-A/TICKFIT-1 pattern) + a persisted chunking verdict. The
review declined it on re-derivation this spec accepts: the predicate itself stays O(corpus)
(its content arm hashes every body in Postgres; `corpusEligible` needs another full count),
it duplicates the projector's eligibility query (a drift class the repo has been burned by),
it would have broken the existing dm pins on `skipped` semantics, and the persisted-verdict
column is low-value once quiet rows are never visited. The batched read removes the ENTIRE
measured cost term — the round-trip count — with none of that surface. The candidate
predicate + verdict persistence are RECORDED in §5 as the revisit design, triggered only by
post-deploy measurement.

**Chartered by:** TICKFIT-1's explicit deferral of this stage ("its own record"); the
slice-A measurement table already listed `graph_project` at 9.9 min beside the backfill it
fixed. No GRAPHCOST overlap (those rows are LLM extraction spend, verified per row).

**Ticketing:** row `TICKFIT-2`; PR carries `AIOS-Work: TICKFIT-2`. **Deps:** none.
**Schema: NONE** (the re-scope deleted the draft's column). **Build with:** fable / high.
Codex (`gpt-5.6-sol`) reviews per the loop's restored order — round 1 produced this
re-scope; round 2 attacks it.

## 0b. Decidables — defaults stated for round 2 to attack

- **D1 — the batched read is a pure FETCH-SHAPE change:** for each existing item page (the
  untouched `GRAPH_PROJECT_LIMIT`=500 pagination on `items_team_synced_idx`), ONE
  `graph_episodes` select over the page's `source_id`s (team + source_table scoped, the
  chunked-IN idiom from `lib/db/batch.ts` — the probe's unique key is
  `(team_id, source_table, source_id, group_id)`, so an item can hold MULTIPLE rows
  (fan-out groups) and the batch result is grouped by `source_id` in JS). The per-row loop
  consumes the prefetched rows exactly where it read the probe result before
  (`project.ts:824-829` is the ONLY site that changes). Every decision, counter, write, and
  error path is byte-identical — the existing projection dm suites must stay green
  UNCHANGED, which is now a real claim (nothing semantic moves), not an aspiration.
- **D2 — per-leg timing lands in the run meta:** `meta.legMs = { walk, reconcile }`
  (wall-clock per leg, per team summed) — the instrumentation gap both TICKFIT specs named.
  The REVISIT TRIGGER is stated with it: if post-deploy `walk` still exceeds ~60s on quiet
  runs, §5's candidate predicate is the recorded next design.
- **D3 — observability is UNCHANGED:** `scanned`/`skipped`/`episodes` and every
  no-silent-caps signal (`saturatedGroups`, `partialItems`, `pendingCleanups`,
  `requeueThrottled`, `fanoutThrottled`) keep their exact meanings and producers. The only
  meta addition is D2's `legMs`.
- **D4 — the reconcile leg and the SATURATED GROUP stay OUT, named loudly:** reconcile
  still does its own O(ledger) SELECT + one 5,000-episode `listEpisodes` per group, and a
  saturated group still heals NOTHING (`reconcile.ts:286-289` — ~2,757 of ~2,761 rows with
  self-healing quietly stopped; the remedy needs a sidecar capability, Graphiti has no
  per-name endpoint). Filed as **GRAPHSAT-1** with the evidence; this slice's claim is the
  projector WALK's round-trip term only — "drops to the reconcile leg's cost" is NOT
  claimed as O(delta) or per-run-flat (the round-1 correction, accepted).
- **D5 — fail direction:** a batched-read error for a page → that page falls back to the
  per-row probe path (today's behavior, page-scoped — bounded, and the fallback is VISIBLE:
  `meta.probeFallbackPages` counts it, so a permanently failing batch read can never
  silently re-become the 10.5-minute stage).

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| the per-row ledger probe (project.ts:824-829) | one sequential round trip per item, 2,826/run | one chunked-IN select per 500-item page, grouped by source_id; the loop reads the prefetch map; page-scoped per-row fallback on error (D5) |
| run meta (projection-run.ts) | no per-leg timing | + `legMs.walk` / `legMs.reconcile`, + `probeFallbackPages` |
| everything else (eligibility query, per-row decisions, counters, reconcile, schema) | — | UNTOUCHED |

## 2. Mechanism notes

- **The chunked-IN idiom** (`lib/db/batch.ts`, `IN_CLAUSE_BATCH`=1000) already used by
  reconcile's orphan lookup — one page of 500 ids fits one chunk.
- **Expected outcome, quantified honestly:** the walk's DB term drops from ~2,826×220ms to
  ~6 round trips; the remaining walk cost is the O(corpus-bytes) chunk+hash CPU (measured
  class: seconds) — `legMs.walk` will report the real number, which is the point of D2.
  The stage total also keeps the reconcile leg (unchanged, its own recorded costs).
- **No cursor/batch/budget mechanics move** — same pages, same `MAX_BATCHES`, same
  single-flight, same interval single-source coupling.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/graph-batched-probe.datamechanics.test.ts`
   exits 0 — real Postgres, a counting/wrapping db client: a converged multi-item corpus
   run performs **≤ ceil(items/500) + K** `graph_episodes` reads in the walk (K = the
   page-count constant, pinned exactly), not one per item — the ROUND-TRIP pin, the slice's
   whole claim; a multi-group (fan-out) item's prefetched rows reach the loop identically
   to the probe path (both groups' rows consumed — the grouped-map pin); the D5 arm — a
   batch-read failure on one page falls back to per-row probes for THAT page only,
   completes correctly, and reports `probeFallbackPages ≥ 1`.
2. Existing projection dm suites (`graph-project`, `graph-tier-move`, `graph-redaction`,
   fan-out, reconcile — the full graph set) green **UNCHANGED** — the byte-identical-
   semantics claim is the review contract, and their existing `skipped`/counter pins are
   the proof it holds.
3. `meta.legMs` present in the recorded run (dm-pinned shape: both legs, numbers ≥ 0);
   `probeFallbackPages` absent/0 on the happy path.
4. Mutations, verdicts verbatim in the PR: (a) revert the batched read to the per-row probe
   → the round-trip pin reddens; (b) drop a group's rows from the prefetch grouping → the
   multi-group arm reddens; (c) disable the D5 fallback → its arm reddens.
5. Full tiers green: `npm test` · dm iso (tolerated: the pre-named TZ artifact + the known
   timeout-flake class, standalone-probed) · `npm run test:http:local` · `npm run check:docs`
   · ARCHITECTURE's graph-leg prose (:115) updated in the same PR; GRAPHSAT-1 filed.

## 4. Out of scope, named

The reconcile leg entirely (its O(ledger) SELECT — stated, not hidden — the per-group
`listEpisodes`, the arc-cache sweeps) and the SATURATED-GROUP healing stall → GRAPHSAT-1;
lowering `GRAPH_PROJECT_MINUTES` (coupled to `LANDED_GRACE_MS` by the single-source guard);
GRAPHCOST-2's ledger shrinking (complementary); the double `ingest_runs` row on overlap.

## 5. The recorded revisit design (NOT built — the declined draft, kept as the trigger's target)

If post-deploy `legMs.walk` stays above ~60s on quiet runs, the next design is the round-1
draft this spec re-scoped away from: a raw-SQL candidate predicate (six arms: no-ledger-row,
sha-inequality, the `''` sentinel, pending-delete, armed-deferral —
`content_sha256 IS DISTINCT FROM` the current body sha per the round-1 derivation — and the
membership/fan-out set-difference EXISTS, which round 1 verified is writable against
`fanout-targets.ts:44`'s join) + the persisted `storedChunkingComplete` verdict (a separate
column bound to the STORED config, never mutating `chunk_config`, never bumping
`projected_at` — round 1's contract corrections, recorded so the revisit starts from them).
