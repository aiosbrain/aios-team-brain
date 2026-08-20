---
access: team
---

# TICKFIT-2 — make graph projection O(delta): the candidate predicate for the projector walk

## 0. What and why

**What:** the `graph_project` stage's per-run walk stops probing every item in the corpus and
instead selects, in ONE SQL query, exactly the rows that need projector work — the
`backfill-candidates` shape (TICKSTALL-2 slice A) applied to the graph leg.

**Why (measured, prod, 2026-08-20):** 56 runs/48h at **10.5 min avg (max 11.4, dead
stable)**, `scanned: ~2826, episodes: 0–14, reconciled: 4, cleaned: 0, requeued: 0` — the
projector walks all ~2,826 eligible items every run and skips 100% of them
(`skipped == scanned` in the run log). The scout traced the cost to **one sequential DB
round trip per item** (`lib/graph/project.ts:824-829` — the per-row `graph_episodes` probe):
2,826 × ~220 ms ≈ 10.4 min, the whole duration. The dead stability is the tell: the
multiplicand is corpus size, the multiplier link latency — the same O(ledger) defect class
TICKSTALL-2 slice A killed for the context sweep (~1.3 s/item × 2,672 measured on the same
DB) and TICKFIT-1 killed for the github stage (0/0/644). There is NO per-row Graphiti call
on the steady-state path (ruled out by the scout — Graphiti is touched per GROUP, in
reconcile only). Secondary waste, named: a double chunk+hash CPU pass per legacy-config row
per run (`project.ts:674` + `:1284` via `storedChunkingComplete`) — O(corpus bytes),
seconds not minutes, but it recomputes and throws away the same verdict every hour (D2).

**Chartered by:** TICKFIT-1's explicit deferral ("the `graph_project` 10.5-min stage — its
own cadence, separate record") and the slice-A measurement table, which already listed
`graph_project` at 9.9 min avg beside the backfill it fixed. **No GRAPHCOST overlap** (the
scout checked every row: those are LLM extraction *spend*, not projector wall time;
GRAPHCOST-1's `chunk_shas`/`chunk_config` ledger is INHERITED here, not rebuilt).

**Ticketing:** row `TICKFIT-2`; PR carries `AIOS-Work: TICKFIT-2`.
**Deps:** none open. **Schema: one additive COLUMN** (D2 — so the migration + schema.sql
mirror per the ADD-COLUMN rule). **Build with:** fable / high. Codex (`gpt-5.6-sol`) is back —
the loop's original order applies (Codex reviews this spec before any code).

## 0b. Decidables — defaults stated for the design review to attack

- **D1 — the candidate predicate is ONE raw-SQL query over `items` × `graph_episodes` (×
  the membership substrate), and it must be wrong only in the MORE-work direction.** The
  slice-A rule verbatim: a predicate wrong the "no work" way silently skips — strictly worse
  than the slowness it replaces, and invisible. The arms (each traced to a state the scout
  proved can change without the `items` row moving — the reason a TICKFIT-1-style
  `synced_at` watermark is WRONG here):
  1. **No ledger row** for an eligible item (new content) — eligibility mirroring the
     projector's own items query (`project.ts:709-724`).
  2. **Content changed:** `ge.content_sha256 <> encode(sha256(convert_to(i.body,'utf8')),'hex')`
     — SQL-reproducible against `sha()` (`project.ts:530`), including the empty-body case.
  3. **The requeue/redaction sentinel:** `ge.content_sha256 = ''` (reconcile re-queues and
     redactions both park the row there — `reconcile.ts:343/:377`).
  4. **A pending cleanup:** `ge.pending_delete_group_id IS NOT NULL`.
  5. **An armed deferral:** `ge.deferred = false` AND the row has not yet been pushed under
     its arming (the precise SQL condition to be pinned against `project.ts:968-986` — a
     review attack point, deliberately).
  6. **A fan-out/membership delta** — the HARD arm, flagged for the review to attack: an
     initiative membership opening/closing (`fanout-targets.ts:57-63`) makes an item need
     fan-out work with NOTHING else changed. Default: an EXISTS comparing current
     initiative memberships against the item's fan-out ledger rows (same-join shape as the
     projector's own target resolution); if the review finds this arm unpinnable in SQL, the
     fallback is a bounded SECONDARY sweep (fan-out-only, its own cheap query) rather than
     keeping the full walk.
  Rows selected by the predicate take today's EXACT per-row path (probe, chunk, compare,
  push, fanout — `project.ts:795-1307` untouched); rows not selected are never probed. The
  chunk-config term is deliberately NOT an arm (D2).
- **D2 — the `storedChunkingComplete` verdict is PERSISTED, not recomputed hourly:** a new
  additive column `graph_episodes.chunk_settled_config text` (null = unverdicted), written
  ONCE per row when `storedChunkingComplete` passes for the stored config
  (`project.ts:352/:1284` — the verdict that today re-chunks the body in Node for most rows
  every run and throws the answer away). The predicate treats `chunk_settled_config IS
  DISTINCT FROM <current CHUNK_CONFIG>` rows as… NOT candidates by config alone (the corpus
  is PERMANENTLY MIXED by the lazy-CDC design — a config-inequality arm would select the
  whole corpus forever, the scout's constraint B); the settled column only lets the per-row
  path skip the second chunk+hash pass. Writing it backfills lazily on each row's first
  post-deploy visit — no bulk migration pass.
- **D3 — observability survives, honestly re-scoped:** `scanned` becomes "candidates
  scanned" (the honest number — TICKFIT-1's rule: a predicate-skip is never folded into
  scanned/unchanged); meta gains `corpusEligible` + `candidates` so the delta is legible;
  every no-silent-caps signal (`saturatedGroups`, `partialItems`, `pendingCleanups`,
  `requeueThrottled`, `fanoutThrottled`) keeps its exact meaning — the reconcile leg that
  produces them is UNCHANGED by this slice. The pipeline-health/staleness readers verified
  against the new shape.
- **D4 — the reconcile leg and the SATURATED GROUP are OUT, named loudly:** even a perfect
  O(delta) projector still pays one 5,000-episode `listEpisodes` for General per run and
  still heals NOTHING inside a saturated group (`reconcile.ts:286-289` — self-healing has
  quietly stopped for ~2,757 of ~2,761 rows; the documented remedy, raising
  `GRAPH_LANDED_SCAN_DEPTH`, makes the stage SLOWER). That is a real, unsolved,
  SEPARATE problem — Graphiti has no per-name lookup endpoint, so the real fix is a sidecar
  change. Filed as its own follow-up row (GRAPHSAT-1) rather than absorbed; this slice's
  claim is the projector WALK only.
- **D5 — fail direction: predicate error → the FULL walk** (today's cost, never a skip);
  the env-tunable batch/budget mechanics (`GRAPH_PROJECT_LIMIT`, `MAX_BATCHES`,
  single-flight, the interval single-source guard) unchanged.

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| the projector walk (`projectItemsToGraph`, lib/graph/project.ts:690-795) | pages ALL eligible items (500/batch), one sequential ledger probe per row (:824) | a candidate query first (D1); only candidates page through the existing per-row path; predicate error → full walk (D5) |
| `storedChunkingComplete` (project.ts:352, called :1284) | recomputed (full re-chunk in Node) for most rows, hourly, discarded | verdict persisted to `chunk_settled_config` (D2); the per-row path consults it before re-chunking |
| `graph_episodes` schema | no projection-state column | + `chunk_settled_config text` (additive migration + mirror) |
| run meta / `ingest_runs` | `scanned` = corpus walk size | `scanned` = candidates; + `corpusEligible`/`candidates`; caps signals unchanged (D3) |
| reconcile leg (lib/graph/reconcile.ts) | one ledger SELECT + one listEpisodes per group + the saturated-group skip | UNCHANGED — out of scope, GRAPHSAT-1 filed (D4) |

## 2. Mechanism notes

- **The precedent is `lib/projects/context/backfill-candidates.ts`** — raw `runSql` (NOT
  the query builder: the joins/EXISTS are not expressible through its surface, and
  fetch-all-and-filter-in-JS is exactly the O(corpus) read being deleted), a header stating
  the dangerous direction, and an SQL-shape guard pinning each arm's load-bearing terms.
- **Expected outcome, quantified:** a quiet run becomes one candidate query (+ the unchanged
  reconcile leg) — the 10.5-min stage drops to the reconcile leg's cost (~seconds + one
  listEpisodes per group). A busy run pays today's per-row path for exactly the delta.
- **The per-row path is NOT rewritten.** Selected rows flow through the existing
  `project.ts:795-1307` machinery byte-for-byte (push, fanout, redaction, tier moves) — the
  slice deletes only the no-op traversal, so every existing dm pin on projection behavior
  keeps its subject.
- **Fail directions:** candidate query error → log + full walk (D5); a settled-column write
  error → the row just recomputes next run (today's behavior); the predicate is
  deliberately superset-safe (any doubt term resolves to "candidate").

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/graph-candidates.datamechanics.test.ts`
   exits 0 — real Postgres: each D1 arm both directions (a new item IS a candidate; an
   unchanged projected item is NOT; a body edit IS; the `''` sentinel IS; a pending-delete
   row IS; an armed (`deferred=false`, unpushed) row IS; a membership/fan-out delta IS —
   or, if the fallback lands, its secondary sweep selects it); the VACUITY pin — a fully
   converged corpus yields ZERO candidates and the projector pass performs ZERO per-row
   ledger probes (spy/counted); the fail direction — a predicate error runs the FULL walk.
2. Same file — D2: a legacy-config row re-chunks ONCE, persists `chunk_settled_config`, and
   the next pass performs no re-chunk (counted); a row whose body changes after settling
   re-verdicts; the settled column never blocks a REAL candidate arm.
3. `npx vitest run test/guards/graph-candidate-sql.test.ts` exits 0 — the SQL-shape guard:
   each arm's load-bearing term pinned (the slice-A guard pattern), with non-vacuity arms.
4. Existing projection dm suites green UNCHANGED (the per-row path untouched is the claim —
   their subjects must not move); mutations, verdicts verbatim in the PR: (a) force the
   predicate to select nothing → the new-item arm reddens; (b) drop the sha-inequality term →
   the body-edit arm reddens; (c) drop the `''` sentinel term → its arm reddens; (d) drop
   the settled-column consult → the recompute-counted arm reddens.
5. Full tiers green: `npm test` · dm iso (tolerated: the pre-named TZ artifact + the known
   timeout-flake class, standalone-probed) · `npm run test:http:local` · `npm run check:docs`
   · migration replay via `db:test:up` + a fresh iso container · ARCHITECTURE's graph-leg
   prose (:115 — the scout named it the largest drift risk) updated in the same PR;
   GRAPHSAT-1 filed with the saturated-group evidence.

## 4. Out of scope, named

The reconcile leg entirely (its O(ledger) SELECT, the per-group `listEpisodes`, the
arc-cache sweeps) and the SATURATED-GROUP healing stall → **GRAPHSAT-1** (needs a sidecar
capability — Graphiti has no per-name endpoint); per-leg timing instrumentation (named
useful by both TICKFIT slices; still its own tiny change); the double `ingest_runs` row on
an overlapping tick (harmless at 60-min cadence, noted by the scout); lowering
`GRAPH_PROJECT_MINUTES` (tempting after the fix, but `LANDED_GRACE_MS` derives from it —
the interval single-source guard exists precisely because these are coupled); GRAPHCOST-2's
ledger-shrinking (complementary, its own row).
