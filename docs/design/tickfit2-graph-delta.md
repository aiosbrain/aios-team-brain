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

- **D1 — the batched read, under an EXPLICIT page-snapshot contract (round 2 killed the
  "byte-identical" claim — round 1's own inherited mistake, its words):** for each existing
  item page, ONE `graph_episodes` select over the page's `source_id`s (+ `source_id` in the
  select list for grouping; the seven consumed columns verified complete by round 2),
  grouped by `source_id` BY REFERENCE (no array clones — memory is page-bounded in ITEM
  count, not ledger bytes), rows DETERMINIZED by `group_id` before the loop consumes them.
  Two semantic deltas, owned rather than denied: (1) SNAPSHOT TIMING — the page's ledger
  state is read once before the loop, so ANY concurrent ledger writer — arming
  (`armDeferredRowsForGroups`), purge/retire (`retireEpisodesForItems`), reconcile's
  never-landed re-queue, a deploy-overlap second projector — is seen at page-start state
  instead of item-start state: the race window widens from milliseconds to page-seconds
  (Fable diff review M5; within a page there is NO cross-item staleness, every in-loop
  ledger write is `source_id`-scoped to the current item — verified). Each of those writers
  converges on the NEXT pass by its existing mechanism (eventual convergence, one-interval
  delay, stated); the one pre-existing hole they share — a tombstone written mid-window and
  then overwritten by the final upsert, whose remedy is an optimistic
  `.eq("content_sha256", <prefetched>)` on that upsert — is out of this slice and named;
  (2) ORDERING — today's fan-out budget spends in UNDEFINED result order;
  the group_id sort FIXES that undefined behavior deliberately (pinned by a capped
  two-group ordering test). The batch select completes BEFORE the loop starts, so the D5
  fallback always begins from an unprocessed page. `project.ts:820-829` is the only
  read-site that changes; every write/decision path is untouched.
- **D2 — per-leg timing lands FLAT in the run meta:** `meta.walkMs` + `meta.reconcileMs`
  (flat numbers — the runs panel renders values via `String(v)`, an object would show
  `[object Object]`; round 2 M), summed per team inside `finally` so failed legs retain
  their elapsed time (walk = the page loop, reconcile = its call — round 2 verified the
  boundaries). The REVISIT TRIGGER stated: quiet-run `walkMs` > ~60s → §5's recorded
  predicate design.
- **D3 — observability is UNCHANGED except the three NEW meta keys** (`walkMs`,
  `reconcileMs`, `probeFallbackPages` — the draft's "only legMs" wording contradicted D5;
  round 2 L): `scanned`/`skipped`/`episodes` and every no-silent-caps signal keep their
  exact meanings and producers.
- **D4 — the reconcile leg and the SATURATED GROUP stay OUT, named loudly:** reconcile
  still does its own O(ledger) SELECT + one 5,000-episode `listEpisodes` per group, and a
  saturated group still heals NOTHING (`reconcile.ts:286-289` — ~2,757 of ~2,761 rows with
  self-healing quietly stopped; the remedy needs a sidecar capability, Graphiti has no
  per-name endpoint). Filed as **GRAPHSAT-1** with the evidence; this slice's claim is the
  projector WALK's round-trip term only — "drops to the reconcile leg's cost" is NOT
  claimed as O(delta) or per-run-flat (the round-1 correction, accepted).
- **D5 — fail direction, DURABLY visible (round 2's recording-gate HIGH):** a batched-read
  error for a page → that page falls back to the per-row probe path (page-scoped; the batch
  read precedes the loop, so the fallback always starts clean). `probeFallbackPages` rides
  (1) the summary, (2) the ABORT path's partial summary + the runner's manual field merge
  (`run.ts:218` — an aborted run must still report its fallbacks), and (3) the CALLER's
  recording gate: a run with `probeFallbackPages > 0` (or a quiet-run `walkMs` over the
  revisit threshold) is ALWAYS recorded to `ingest_runs`, even when the scheduler's
  quiet-run gating would otherwise skip the row — a permanently failing batch read must
  never be invisible. AC-pinned at the caller gate, not just the input builder — and there
  are TWO callers (the scheduler tick and the admin "Project to graph" button, which carried
  its own inline copy that had already drifted five signals behind — Fable diff review M2);
  both route through the one exported predicate `shouldRecordProjectionRun`
  (`lib/graph/projection-run.ts`), pinned per clause AND per call site in
  `test/graph-recording-gate.test.ts`. The `walkMs` clause is summed across teams, so a
  multi-team instance can cross the threshold with no slow team — one extra quiet row,
  accepted and stated.

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| the per-row ledger probe (project.ts:824-829) | one sequential round trip per item, 2,826/run | one chunked-IN select per 500-item page, grouped by source_id; the loop reads the prefetch map; page-scoped per-row fallback on error (D5) |
| run meta (projection-run.ts + the scheduler's recording gate) | no per-leg timing; quiet runs may skip the durable row | + flat `walkMs`/`reconcileMs` + `probeFallbackPages`; fallback/slow-walk runs ALWAYS recorded; abort-path merge carries the counter |
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
   exits 0 — real Postgres, a counting/wrapping db client: the ROUND-TRIP pin with K pinned
   EXACTLY (the walk's `graph_episodes` reads = the number of item pages — one batched
   select per page, zero per-item probes; reconcile's reads and write-path RETURNING
   queries excluded from the count by scoping the counter to the walk); the multi-group
   (fan-out) item's prefetched rows reach the loop grouped and SORTED by group_id (the
   determinized-order pin: a capped two-group budget arm proves which group receives scarce
   budget is now deterministic); the D5 arm — a batch-read failure on one page falls back
   to per-row probes for THAT page only, completes correctly, and `probeFallbackPages ≥ 1`
   survives BOTH the success path and a forced ABORT (the partial-summary merge pin); the
   TRACE-EQUIVALENCE arm (round 2 L): on a stable converged corpus, a batched pass and a
   forced-fallback pass produce identical summaries (minus the fallback counter).
2. Existing projection dm suites (`graph-project`, `graph-tier-move`, `graph-redaction`,
   fan-out, reconcile — the full graph set) green **UNCHANGED** — the byte-identical-
   semantics claim is the review contract, and their existing `skipped`/counter pins are
   the proof it holds.
3. `npx vitest run test/graph-recording-gate.test.ts test/graph-projection-run.test.ts`
   exits 0: `meta.walkMs`/`meta.reconcileMs` present and ≥ 0 in the recorded run; the
   CALLER-GATE arm: `shouldRecordProjectionRun` is false for a quiet converged summary,
   true with ONLY `probeFallbackPages: 1`, true with ONLY `walkMs` strictly past
   `SLOW_WALK_RECORD_MS` (false AT it), true for every pre-existing signal alone;
   `probeFallbackPages` absent from meta at 0; and BOTH call sites (scheduler tick, admin
   button) pinned at the source level to call the shared predicate with no inline copy.
4. Mutations, verdicts verbatim in the PR: (a) ignore the prefetch (`if (prefetch)` →
   `if (!prefetch)`) → the probe-count pin reddens (the batch count alone would NOT — the
   round-trip pin counts per-item probes separately, Fable diff review M3); (b) remove the
   group_id sort → the multi-group arm reddens on both attempts (the test serves the batch
   rows in DESCENDING group order, so the planner cannot rescue the mutant — M4);
   (c) disable the D5 fallback counter merge → its arm reddens; (d) drop the
   `probeFallbackPages` clause from the gate → the gate suite reddens.
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
