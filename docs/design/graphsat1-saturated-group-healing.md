---
access: team
---

# GRAPHSAT-1 — the saturated group heals again (a direct per-name episode lookup, no sidecar change)

Deps: none (TICKFIT-2 / PR #629 touches `run.ts`/`projection-run.ts` too — a textual merge, not a
dependency; whichever lands second rebases). Build-with: fable / high (the failure direction is a
metered re-push loop). Reviewers: Codex gpt-5.6-sol on the spec and the diff; Fable on the diff.

## 0. What and why

**The stall, measured (prod, read-only, 2026-08-21).** `graph_episodes` holds **2,833 rows in
`aios_team`** (General) and 4 in `aios_external`. Reconcile's landed check lists each group at
`GRAPH_LANDED_SCAN_DEPTH = 5000` (`lib/graph/reconcile.ts:99`, `:280`) and treats a FULL window as
inconclusive — the group is skipped wholesale (`reconcile.ts:286-289`). General's ledger records
**6,915 chunk episodes** for its 2,833 rows (plus an unknown number of duplicates/orphans), so the
window is full on every pass: `ingest_runs.meta.saturatedGroups = 1` on 95 of the last 7 days'
recorded runs, and `reconciled = 4` on every one of them — **only the external group's four rows are
ever confirmed**. What General has lost, every hour since it crossed 5,000 episodes
(`reconcile.ts:290-379`, everything below the `continue`): landed confirmation, the `episode_uuid`
backfill (**648 rows have no uuid today**), the `partialItems` measurement the RECONCILE-1 slice
exists to take (so the "how many multi-chunk holes are real" question is unanswered for 99.9% of
the corpus), and BOTH re-queue branches (never-landed, and pending-delete-with-re-push). Not
measurable from a laptop: the exact Episodic count in General (Neo4j and Graphiti are
internal-only — no public proxy); the lower bound is 5,000 (the full window), the ledger's own count
is 6,915.

**The ticket's premise was wrong, and the scout proved it.** TICKFIT-2 D4 filed this as "needs a
sidecar capability — Graphiti has no per-name endpoint". The REST surface claim holds
(`lib/graph/graphiti-client.ts:3-14`: `GET /episodes/{group}?last_n=` is the only listing; no offset,
no name filter). But the brain ALREADY reads Neo4j directly over bolt: `lib/graph/neo4j.ts`
(`runRead`, pooled driver, `NEO4J_URL` set in prod — `docs/RAILWAY-TEMPLATE.md:38`), consumed by
`lib/graph/learning.ts`, `lib/graph/extraction-health.ts`, `lib/graph/extraction-alert.ts`. The EXACT query shape this slice needs
already ships twice: Episodic by group + uuid set (`lib/graph/learning.ts:149-152`) and Episodic by
group + name prefix (`lib/graph/extraction-health.ts:567-569`). Graphiti's own index
`episode_group_id ON (n:Episodic) ON (n.group_id)` serves the group term; there is NO index on
`Episodic.name`, so the name term is a property filter over the group's index scan — fine at ~7k
nodes, stated not assumed.

**Why heal at all (the product intent, already written down).** `lib/graph/landed-state.ts:5-27`
records that enforcement on a TRUNCATED scan is self-amplifying (a re-queue re-pushes all chunks;
`addEpisodes` does not overwrite by name; the group grows toward the window; healing switches off
"permanently"). That argument is about truncation. A per-name lookup is EXACT — "absent" means the
node is not in the group, not "beyond the window" — so the hazard the guard exists for does not
apply to the lookup path. The guard stays for the REST path, byte-for-byte.

## 0b. Decidables — defaults stated for the design round to attack

- **D1 — the lookup is a FALLBACK for the saturated case only; the REST path is untouched.** For
  each group, reconcile lists via REST exactly as today. If the window is NOT full → today's code,
  unchanged (every existing pin stays green by construction). If the window IS full → instead of
  `continue`, resolve the group's expected episode names via `lookupEpisodesByName(groupId, names)`
  (a direct Cypher read, `MATCH (e:Episodic) WHERE e.group_id = $g AND e.name IN $names RETURN
  e.uuid AS uuid, e.name AS name`, names chunked at `LOOKUP_NAME_BATCH = 500`), and feed the result
  into the SAME `presentNames` set + FIRST-WINS `uuidByItemId` map the REST path builds
  (`reconcile.ts:292-301`) — so confirmation, uuid backfill, `partialItems`, and both re-queue
  branches run on identical downstream code. The expected names for the group are
  `expectedEpisodeNames(row.source_id, row.chunk_shas.length)` over the group's ledger rows
  (`landed-state.ts:39`, the single owner of the name convention), PLUS the bare `items:<id>` form
  for multi-chunk rows (a legacy single-episode landing — the "hole-by-renaming" class
  `reconcile.ts:312-318` names stays uncounted exactly as today, but a legacy landing must still
  CONFIRM the item rather than be re-queued as never-landed). Alternative considered and rejected:
  always-Cypher (drop REST listing). Rejected because it makes Neo4j a HARD dependency of a leg that
  today has one, and because the REST path's existing dm pins (`test/datamechanics/graph-project.datamechanics.test.ts`
  §reconcile) are the proof the unchanged 99% stays unchanged.
- **D2 — every failure degrades to TODAY, never to "none landed".** `NEO4J_URL` unset → today's
  skip-and-count; driver/transport error or a query throw → today's skip-and-count; a chunk of the
  name lookup failing → the WHOLE group is skipped-and-counted for this pass (a partial name set
  would read absent-because-unfetched as never-landed — the fail-toward-re-push direction this must
  never take, the same rule TICKFIT-2 L1 applied to the batched ledger read). Pinned: a lookup that
  throws on the 2nd chunk yields `saturatedGroups 1, reQueued 0, confirmed 0`.
- **D3 — visibility splits the counter rather than overloading it.** `saturatedGroups` keeps
  its meaning: groups past the window that were NOT judged this pass (lookup unavailable/failed).
  New: `deepResolvedGroups` — groups past the window that WERE judged via the lookup. Both ride
  `ReconcileSummary` → `GraphProjectionSummary` → `ingest_runs.meta` → the recording gate
  (`shouldRecordProjectionRun` gains `deepResolvedGroups`? NO — a healthy deep-resolved pass over a
  converged group is QUIET; a gate clause would record a row every hour forever. `saturatedGroups`
  stays a gate signal because it now means "a group is not being judged"; `deepResolvedGroups` is
  meta-only). The scheduler log line names deep-resolved groups when non-zero.
- **D4 — the first deployment MEASURES before it RE-QUEUES (the RECONCILE-1 pattern).** On the
  first judged pass over General the lookup will confirm most of 2,833 rows, backfill 648 uuids,
  and count `partialItems` — and find some number N of rows whose names are ALL absent. Each such
  row past `LANDED_GRACE_MS` is a never-landed re-queue → a full re-push → metered extraction, at
  `GRAPH_REQUEUE_MAX_PER_PASS = 20` per pass → up to 480 items/day. N is UNKNOWN (the measurement
  this slice restores is the one that would tell us), and a systematic mismatch (e.g. a legacy
  naming form this spec did not anticipate) would make N ≈ 2,833 and burn 20 extractions/hour
  until noticed. So: `GRAPH_DEEP_REQUEUE` (env, default **false**) gates ONLY the two re-queue
  branches on the lookup path — confirmation, uuid backfill, and `partialItems` run regardless;
  rows that WOULD have been re-queued are counted as `deepRequeueHeld` (meta, durable) instead.
  The revisit trigger is explicit: read `deepRequeueHeld` and `partialItems` from `ingest_runs`
  after the first prod passes; if `deepRequeueHeld` is small and its sample (a bounded
  `deepRequeueSample` of ≤5 item ids, same shape as `partialDetail`) checks out by hand, flip
  the flag. Alternative rejected: shipping re-queue ON with the 20/pass throttle as the only
  bound — the throttle bounds the RATE, not the DIRECTION, and a wrong direction at 480/day is
  the cost-explosion class GRAPHCOST-* spent a month removing.
- **D5 — isolation and congruence.** `group_id = $g` is the SOLE isolation term (no RLS backstop
  — CLAUDE.md §5); the lookup is group-scoped by the ledger's `graph_episodes.group_id`, the same
  ids the extraction-health census already proves congruent with Neo4j's `group_id`
  (`extraction-health.ts:555-557`). Names are exact-match (`IN`), never prefix — `items:abc` must
  not confirm `items:abc#3`'s item through a different row.
- **D6 — the Cypher lives in a NEW owner module**, `lib/graph/episode-lookup.ts` (new file), not in
  `lib/graph/learning.ts`: the `lib/graph/neo4j.ts:8` rule ("all Cypher lives in `lib/graph/learning`") is already
  stale (`lib/graph/extraction-health.ts` holds Cypher), so this slice widens the rule EXPLICITLY in the
  `lib/graph/neo4j.ts` header rather than silently adding a third violator. The module exports the lookup
  AND a `neo4jEpisodeLookup` default; `reconcileProjectedEpisodes` takes the lookup as an
  injectable argument (default = the Neo4j one) so the dm tier drives the saturated path with a
  fake lookup and the `test:neo4j` tier proves the real Cypher against a real Neo4j.

## 1. The surface table

| Surface | Change |
|---|---|
| `lib/graph/episode-lookup.ts` (new file, to create) | `lookupEpisodesByName(groupId, names)` over `runRead`, chunked; returns `null` when `!neo4jConfigured()`; throws on transport/query error (the caller owns the degrade) |
| `lib/graph/reconcile.ts` | the saturated branch: lookup → same downstream; `deepResolvedGroups`, `deepRequeueHeld`, `deepRequeueSample`; `GRAPH_DEEP_REQUEUE` flag; injectable lookup |
| `lib/graph/run.ts`, `lib/graph/projection-run.ts`, `lib/graph/scheduler.ts` | the three counters ride summary → meta → log line; `saturatedGroups` stays the gate signal |
| `lib/graph/neo4j.ts` | header: the Cypher-ownership rule widened explicitly |
| `test/datamechanics/fake-graphiti.ts` | unchanged (the lookup is injected, not a client method) |
| `docs/ARCHITECTURE.md:115` | saturation prose added (it has NONE today — a live drift gap TICKFIT-2 promised to close) |
| Schema | **NONE** |

## 2. Mechanism notes

- The lookup returns `{uuid, name}[]`; building `presentNames`/`uuidByItemId` from it is the same
  loop as `reconcile.ts:296-301` over a different source — extracted into one helper used by both
  paths so the two cannot drift.
- Expected names per group are computed ONCE per group from its ledger rows; a row with
  `chunk_shas = []` contributes nothing (it is the never-pushed discriminator, `reconcile.ts:354`,
  and `landedState` reports `none` for it without a lookup).
- Name-list size for General ≈ 6,915 + 2,833 legacy forms ≈ 9.7k names → ~20 chunks of 500 per
  pass, each a group-index scan + property filter. Payload: the RESULT set only (present names +
  uuids), not the whole group — strictly less transfer than the 5,000-episode REST window it
  replaces for this group.
- The tier-cleanup leg (`reconcile.ts:388-501`, `GROUP_SCAN_DEPTH` 100,000, its own `saturated`
  flag that blocks only the flag-CLEAR) and `deleteItemEpisodes` (`project.ts:651`) stay on REST —
  out of scope, named in §4.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/graph-saturated-heal.datamechanics.test.ts`
   exits 0 — real Postgres, `FakeGraphiti` filled past `LANDED_SCAN_DEPTH`, an INJECTED lookup:
   (a) the saturated group is JUDGED — `deepResolvedGroups 1`, `saturatedGroups 0`, a landed row
   `confirmed` with its `episode_uuid` backfilled, a row missing one of three chunks counted in
   `partialItems` with the missing name in `partialDetail`; (b) a never-landed row past the grace
   with the flag OFF is HELD — `deepRequeueHeld 1`, its id in `deepRequeueSample`, `reQueued 0`,
   `content_sha256` untouched; (c) the same row with `GRAPH_DEEP_REQUEUE=true` (injected option)
   is re-queued — `reQueued 1`, `content_sha256 = ''`, `first_seen_at` preserved (STALLSCOPE-1);
   (d) D2: a lookup that returns `null` (unconfigured) → today's verdict exactly
   (`saturatedGroups 1, reQueued 0, confirmed 0`, ledger untouched); a lookup that THROWS on its
   second chunk → the same; (e) D5: the lookup is called with the ledger's `group_id` and names
   that are EXACT (`items:<id>`, `items:<id>#k`), never a prefix; a present name for a DIFFERENT
   item does not confirm this one.
2. `npm run test:datamechanics:iso test/datamechanics/graph-project.datamechanics.test.ts` exits 0
   with ONE consciously revised pin: the existing saturated-group arm (`:801-820`) keeps
   `reQueued 0` and the ledger row, and its `saturatedGroups 1` assertion now runs with the
   default lookup UNCONFIGURED (`NEO4J_URL` unset in the dm tier) — i.e. it becomes the D2 pin for
   the real default, not a fake. The cleanup-leg saturation pin (`:844-874`) and the throttle pin
   (`:779-799`) stay green UNCHANGED.
3. `npm run test:neo4j` (after `npm run db:test:neo4j:up`; self-skips without `NEO4J_TEST`) exits 0
   with a new arm in `test/graph-neo4j-tier.test.ts`: real `(:Episodic {uuid, name, group_id})`
   nodes in two groups; `lookupEpisodesByName(groupA, [...])` returns ONLY group A's matches, with
   their uuids, for exact names; a name present only in group B is absent; >500 names chunk
   correctly (the same names resolve across the chunk boundary).
4. `npx vitest run test/graph-recording-gate.test.ts test/graph-projection-run.test.ts` exits 0:
   `meta.deepResolvedGroups`, `meta.deepRequeueHeld`, `meta.deepRequeueSample` reach the durable
   row; `shouldRecordProjectionRun` is FALSE for a quiet deep-resolved pass
   (`deepResolvedGroups 1`, all else zero) and TRUE for `saturatedGroups 1` alone (unchanged).
5. Mutations, verdicts verbatim in the PR: (a) make the saturated branch `continue` again (ignore
   the lookup) → AC1(a) reddens; (b) drop the partial-chunk failure → whole-group skip (use the
   partial name set) → AC1(d) reddens; (c) invert the `GRAPH_DEEP_REQUEUE` gate → AC1(b) reddens;
   (d) change the Cypher `=` group term to `IN $g`-less / drop it → AC3's cross-group arm reddens;
   (e) prefix-match names (`STARTS WITH`) → AC1(e)/AC3 reddens.
6. Full tiers green: `npm test` · dm iso (the graph set) · `npm run test:http:local` ·
   `npm run check:docs` · `docs/ARCHITECTURE.md:115` gains the saturation + lookup prose.

## 4. Out of scope, named

- The tier-cleanup leg's 100,000-deep REST listing and `deleteItemEpisodes`' scan — they resolve
  names→uuids through `listEpisodes` today and keep doing so; a lookup-backed delete is its own
  slice (it changes an access-control latch: `docs/design/phase-c-per-project-graphs.md:55`
  builds partition suppression on `pending_delete` staying set while a scan is inconclusive).
- The hole-by-renaming class (`reconcile.ts:312-318`) — still uncounted, deliberately.
- Flipping `GRAPH_DEEP_REQUEUE` on — a human decision after reading the first passes' meta (D4).
- The admin button's inline recording gate — already unified in TICKFIT-2 (#629, pending merge);
  this slice does not touch it. If #629 merges first, `deepResolvedGroups` is NOT added to the
  shared gate (D3); if this merges first, the same ruling applies to the scheduler's gate.
- Duplicate-episode cleanup inside General (the amplification the stall already caused) — a
  different slice, needs the measurement this one restores.
