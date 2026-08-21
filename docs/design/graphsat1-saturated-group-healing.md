---
access: team
---

# GRAPHSAT-1 — the saturated group heals again (a direct per-name episode lookup, no sidecar change)

Deps: **TICKFIT-2 (PR #629)** — this slice STACKS on `chetan/tickfit2-graph-delta` (PR base = that
branch until it merges, then retargeted to `main`): the counters ride the ONE recording gate
`shouldRecordProjectionRun` and `meta.reconcileMs` that #629 introduces (Codex design round 1 M3:
"Deps: none" was false — AC4 named a suite that exists only on #629). Build-with: fable / high (the
failure direction is a metered re-push loop). Reviewers: Codex gpt-5.6-sol on the spec and the
diff; Fable on the diff.

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

- **D1 — the lookup is a FALLBACK for the saturated case only, and it resolves by ITEM IDENTITY,
  not by current expected names (Codex design round 1 BLOCKER).** For each group, reconcile lists
  via REST exactly as today. If the window is NOT full → today's code, unchanged (every existing
  pin stays green by construction). If the window IS full → instead of `continue`, resolve the
  group's ledger items via `lookupItemEpisodes(groupId, itemIds)`: a direct Cypher read
  `MATCH (e:Episodic) WHERE e.group_id = $g AND e.name STARTS WITH 'items:' AND
  split(e.name, '#')[0] IN $itemNames RETURN e.uuid AS uuid, e.name AS name` with
  `$itemNames = itemIds.map((id) => \`items:${id}\`)`, chunked at `LOOKUP_BATCH = 500` ids. This
  returns EVERY present chunk of every ledger item — `items:x`, `items:x#0`, `items:x#7`, a legacy
  single-episode landing, a pre-shrink `#0..#2` set — exactly the population the REST path sees for
  those items, and it is fed into the SAME `presentNames` set + FIRST-WINS `uuidByItemId` map the
  REST path builds (`reconcile.ts:292-301`, extracted into one helper both paths call), so
  confirmation, uuid backfill, `partialItems`, the documented hole-by-renaming under-count
  (`reconcile.ts:312-318` — a shrunk doc still CONFIRMS through its legacy `#0`, exactly as today),
  and both re-queue branches run on identical downstream code. WHY NOT expected names: a doc that
  shrank 3→1 chunks has `chunk_shas.length 1` and expects `items:x`, but delta projection never
  wrote that name — the REST path confirms it via `itemIdFromEpisodeName("items:x#0")`; a
  name-based lookup would have judged it never-landed and (flag on) re-pushed a landed row. The
  flag would only have postponed that wrong verdict. Pinned by explicit shrink 3→1 and grow 1→N arms (AC1). (A
  "chunk-config-transition" arm was claimed in an earlier draft and STRUCK: reconcile never reads
  `chunk_config`, so the arm would have been green by construction — a config transition is
  observable only as a chunk-COUNT change, which the shrink/grow arms ARE. Fable diff review M3.)
  Prefix is `STARTS WITH 'items:'` (`ITEM_EPISODE_PREFIX`)
  so `correction:<arc_id>` writebacks are never considered; the item term is EXACT equality on the
  pre-`#` stem, so `items:abc` can never confirm `items:abcd`. Alternative considered and rejected:
  always-Cypher (drop REST listing) — it makes Neo4j a HARD dependency of a leg that today has one,
  and the REST path's existing dm pins (`test/datamechanics/graph-project.datamechanics.test.ts`
  §reconcile) are the proof the unchanged 99% stays unchanged.
- **D2b — THE REST-WINDOW ORACLE (Fable diff review M1).** The 5,000 newest episodes reconcile
  already holds are a guaranteed SUBSET of what the lookup must return for the group's ledger
  items. Before any verdict, every item the window confirms must be confirmed by the lookup; if any
  is missed, the lookup is structurally broken (a reachable Neo4j that is not the one Graphiti
  writes — the graphiti-restart-rebuild incident shape; a renamed property; a future store
  cutover) and the group is degraded to UNJUDGED (`saturatedGroups++` AND `lookupMismatchGroups++`,
  a gate signal, a loud log line naming `NEO4J_URL`). An EMPTY result is not an error, so without
  this a wrong graph reads as "everything never landed" — loud with the flag off (held 2,833), a
  rate-bounded self-amplifying re-push with it on. Now that class dies by construction, not by a
  human reading `deepRequeueHeld`. The check is subset, not equality (the lookup legitimately sees
  MORE than the window); an episode deleted between the two reads trips it for one pass in the safe
  direction. When the window confirms none of the group's items the oracle is vacuous and the
  lookup is trusted — stated.
- **D2 — every failure degrades to TODAY, never to "none landed".** `NEO4J_URL` unset → today's
  skip-and-count; driver/transport error or a query throw → today's skip-and-count; a chunk of the
  name lookup failing → the WHOLE group is skipped-and-counted for this pass (a partial name set
  would read absent-because-unfetched as never-landed — the fail-toward-re-push direction this must
  never take, the same rule TICKFIT-2 L1 applied to the batched ledger read). Pinned at BOTH
  layers (round 1 M1): a UNIT test on `lib/graph/episode-lookup.ts` mocks the per-batch `runRead`,
  returns matches for batch 1 and throws on batch 2, and asserts the exported lookup REJECTS
  without yielding any rows (an implementation that swallowed batch 2 and returned batch 1 would
  be the partial-set bug); and a dm arm where the injected lookup throws yields today's verdict
  (`saturatedGroups 1, reQueued 0, confirmed 0`, ledger untouched).
- **D3 — visibility splits the counter, and MEASUREMENT MODE IS LOUD (round 1 H1).**
  `saturatedGroups` keeps its meaning: groups past the window that were NOT judged this pass
  (lookup unconfigured/failed) — still a gate signal. New: `deepResolvedGroups` (groups past the
  window judged via the lookup), `deepRequeueHeld` (rows the lookup judged never-landed that the
  flag held back), `deepRequeueHeldByGroup` (`{ [groupId]: n }` — per-group counts, so the
  population is enumerable), `deepRequeueSample` (≤5 held rows as STRUCTURED identities
  `{ teamId, groupId, itemId, projectedAt }` — an item id alone is not operationally
  identifiable across groups/teams, round 2 H2 — OLDEST `projectedAt` first, EVERY identity up to
  `DEEP_REQUEUE_SAMPLE_LIMIT` (50), merged and re-bounded across teams in the runner, with
  `deepRequeueElided` = held − sample recomputed from the totals after the re-bound). The admin runs panel's
  `RunMeta` renders object values as compact JSON instead of `String(v)` (which printed
  `[object Object]` for `partialDetail` already — fixed in passing, pinned). The keys ride the meta
  only when they say something (like `probeFallbackPages`/`lockedOut`): a deep-resolved row carries
  `deepResolvedGroups` + `deepRequeueEnabled` (self-describing about its mode), a held row adds the
  count/map/sample, a mismatch row `lookupMismatchGroups`; a quiet unsaturated team's row is not
  padded with zeros (Fable diff review L3). Gate rule, on the ONE shared
  predicate `shouldRecordProjectionRun`: `deepRequeueHeld > 0` ALWAYS records (work is being
  held — that is a signal); and while `GRAPH_DEEP_REQUEUE` is OFF, `deepResolvedGroups > 0` ALSO
  records — the rollout phase is the measurement phase, and a "lookup succeeded, zero held" result
  must be a durable row the operator can read, not an absence they must infer. Once the flag is
  ON, a quiet deep-resolved pass is quiet (meta-only), like any other converged pass. The
  flag is resolved ONCE in `runGraphProjection` (env parse, or the injected option), passed into
  reconcile as the mode it executes, and RETURNED on `GraphProjectionSummary.deepRequeueEnabled`
  — the gate reads the EXECUTED mode from the summary it is already given (round 2 M1: the
  predicate stays pure, both call sites stay `shouldRecordProjectionRun(s)`, and no second env
  parse can disagree with the mode reconcile actually ran).
  The scheduler log line names deep-resolved/held counts when non-zero. Round 1 also asked that
  the durable path be proven end to end, not just the mapper: AC4 pins the predicate AND the
  projection-run meta AND (dm) an actual `ingest_runs` row written by the scheduler-equivalent
  call path for a held-only summary.
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
  **This slice ships MEASUREMENT-ONLY; the flag is the mechanism, not a promise that it is
  safe to flip (round 1 H2, round 2 H1).** `LANDED_GRACE_MS` is one projection interval (1h), but
  graphiti's worker is SERIAL at ~1 episode/minute and prod's own first ingest hour queued 175
  items (`extraction-health.ts:581`) — so a row older than the cutoff can be QUEUED, not lost, and
  a per-item absence cannot tell the two apart. Round 2 killed the first enable protocol
  (a stable oldest-5 sample does NOT govern the held SET — unseen rows can churn at equal
  cardinality; worker liveness proves the worker is alive, NOT that these absences are outside
  its backlog — `extraction-health.ts:578` treats live work elsewhere as evidence of queue depth).
  What governs enabling, honestly: EITHER (a) `deepRequeueHeld` is small enough that EVERY held
  candidate is checked individually — and "small" is now a NUMBER the row itself certifies
  (Codex diff review M2: a fixed oldest-5 sample could never enumerate a stable sixth row):
  every held identity rides the durable row up to `DEEP_REQUEUE_SAMPLE_LIMIT = 50`; past it
  `deepRequeueElided > 0` declares the population NON-enumerable from `ingest_runs` and the flag
  ineligible, stated rather than truncated — OR (b) the structural successor ships first: a persisted per-row
  "judged absent since / consecutive absent passes" so re-queue requires K consecutive absences
  by construction (schema — NOT this slice, filed as GRAPHSAT-2 if measurement shows held rows
  are common). Until one of those holds, the flag stays off and the spec says so.
  Alternative rejected: shipping re-queue ON with the 20/pass throttle as the only
  bound — the throttle bounds the RATE, not the DIRECTION, and a wrong direction at 480/day is
  the cost-explosion class GRAPHCOST-* spent a month removing.
- **D5 — isolation and congruence.** `group_id = $g` is the SOLE isolation term (no RLS backstop
  — CLAUDE.md §5); the lookup is group-scoped by the ledger's `graph_episodes.group_id`, the same
  ids the extraction-health census already proves congruent with Neo4j's `group_id`
  (`extraction-health.ts:555-557`). The item term is exact equality on the pre-`#` stem. Because
  this lookup DRIVES POSTGRES MUTATIONS (uuid backfill, re-queue), the source-level tier guard
  `test/guards/graph-tier-filter.test.ts` — which today scans only `lib/graph/learning.ts` for
  `group_id IN $groups` — is widened to an owned-module list that includes
  `lib/graph/episode-lookup.ts`, requiring `e.group_id = $g` in every Cypher block there
  (round 1 M5) — and the guard STRIPS Cypher comments (`//…` and `/*…*/`) before matching for
  BOTH modules, since a comment containing the term satisfied the old regex (round 2 M3); each
  owned module must contain ≥1 block (non-vacuity per module). `NEO4J_URL`/`NEO4J_USER`/`NEO4J_PASSWORD` are SET on the prod brain service
  (observed via `railway variables`, 2026-08-21 — not inferred from the template).
- **D5b — the flag's contract.** `GRAPH_DEEP_REQUEUE` enables re-queue on the lookup path iff
  `process.env.GRAPH_DEEP_REQUEUE === "true"` (exact; `"false"`, `"1"`, `"yes"`, unset → OFF —
  a truthiness check would make `=false` enable it, round 1 M4). `reconcileProjectedEpisodes`
  takes ONE options object `{ lookup?, deepRequeue?, maxRequeuePerPass? }` — the existing
  positional `maxRequeuePerPass` seam moves INTO it (round 2 M2: the throttle pin at
  `graph-project.datamechanics.test.ts:757` passes an explicit cap and must keep working) —
  whose defaults are the Neo4j lookup, OFF, and `REQUEUE_MAX_PER_PASS`; the runner passes the
  resolved flag; tests inject all three. Parse pinned for unset/"false"/"true"/arbitrary.
- **D5d — every bolt read has a FINITE deadline (Codex diff review H1).** The lookup runs INSIDE
  #629's per-team lease and the process single-flight; the Graphiti REST calls there carry a 30 s
  abort, and a bare `executeRead` carried none — a stalled Neo4j would have stranded the lease
  and stopped projection for every later team on that instance while twins locked out forever.
  `lib/graph/neo4j.ts` `runRead` now passes a server-side transaction timeout
  (`NEO4J_READ_TIMEOUT_MS`, default 30 s; `0`/blank/garbage → the default, never "no deadline"),
  pinned at the config AND the call site (a mocked driver captures `executeRead`'s config). This
  hardens the pre-existing learning/extraction-health reads too.
- **D5e — the Integrations panel stays source-diverse (Codex diff review L3).** While the flag is
  off a saturated healthy group records an instance-wide row hourly; `listRecentIngestRuns`
  merges null-team rows into every team's 30-row panel, so ~30 quiet hours could have buried an
  older connector failure that used to stay visible. `diversifyBySource` caps any one `source`
  at half the panel while other sources still have rows (the cap lifts once they are exhausted;
  newest-first order preserved), unit-pinned. The raw hourly rows D4 needs are untouched.
- **D5c — the dm tier is hermetic to Neo4j.** `vitest.datamechanics.config.ts` sets
  `process.env.NEO4J_URL = ""` before module load (it already blanks every LLM transport); a
  dev shell exporting a real URL can no longer flip the saturated pin by deep-resolving against
  unrelated local state (round 1 M2).
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
| `lib/graph/episode-lookup.ts` (new file, to create) | `lookupItemEpisodes(groupId, itemIds)` over `runRead`, chunked at 500 ids; returns `null` when `!neo4jConfigured()`; REJECTS (no partial rows) on any batch error — the caller owns the degrade |
| `lib/graph/reconcile.ts` | the saturated branch: lookup → the SAME presence-map helper → same downstream; `deepResolvedGroups`, `deepRequeueHeld`, `deepRequeueSample`; options `{ lookup?, deepRequeue?, maxRequeuePerPass? }` |
| `lib/graph/run.ts`, `lib/graph/projection-run.ts`, `lib/graph/scheduler.ts` | the counters ride summary → meta → log line; `shouldRecordProjectionRun` gains `deepRequeueHeld` + the measurement-mode clause (reads `s.deepRequeueEnabled`, resolved once in the runner) |
| `lib/graph/neo4j.ts` | header: the Cypher-ownership rule widened explicitly; `runRead` under a finite transaction deadline (`readTxConfig`) |
| `lib/ingest/runs.ts` | `diversifyBySource` in `listRecentIngestRuns` (pure, unit-pinned) |
| `test/guards/graph-tier-filter.test.ts` | owned-module list: `learning.ts` (`group_id IN $groups`) + `episode-lookup.ts` (`group_id = $g`) |
| `vitest.datamechanics.config.ts` | `NEO4J_URL = ""` |
| `test/datamechanics/fake-graphiti.ts` | unchanged (the lookup is injected, not a client method) |
| `docs/ARCHITECTURE.md:115` | saturation prose added (it has NONE today — a live drift gap TICKFIT-2 promised to close) |
| Schema | **NONE** |

## 2. Mechanism notes

- The lookup returns `{uuid, name}[]`; building `presentNames`/`uuidByItemId` from it is the same
  loop as `reconcile.ts:296-301` over a different source — extracted into one helper used by both
  paths so the two cannot drift.
- The lookup's input is the group's ledger ITEM ids (2,833 for General → 6 chunks of 500), each
  chunk a group-index scan + `split()` property filter over ~7k+ Episodic nodes (no `name` index —
  stated). Payload: the RESULT set only (present names + uuids, ~7k rows for General on a healthy
  pass) — comparable to the 5,000-episode REST window it replaces, and EXACT rather than truncated.
- The first judged pass over General issues up to 648 row-scoped `episode_uuid` updates
  (`reconcile.ts:322`) — each independent, retry-safe (a null uuid is simply backfilled next pass),
  no lock interaction; `meta.reconcileMs` (from #629) records what it cost, so the "first pass" is
  measured, not assumed (round 1 L2). A bulk `update … from (values …)` is the named optimization
  if that number matters.
- Prod measurement for the BLOCKER's class: 0 pre-chunking multi-chunk rows (every pre-2026-07-17
  row is single-chunk); 3 chunk configs in use (`2500x16` 2,073 · `cdc1-2500-1250-4000-80` 652 ·
  `2500x40` 112) — config transitions are real in prod, so the shrink/grow/transition arms are not
  hypothetical. First uuid-less row: 2026-08-04 — the saturation date.
- The tier-cleanup leg (`reconcile.ts:388-501`, `GROUP_SCAN_DEPTH` 100,000, its own `saturated`
  flag that blocks only the flag-CLEAR) and `deleteItemEpisodes` (`project.ts:651`) stay on REST —
  out of scope, named in §4.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/graph-saturated-heal.datamechanics.test.ts`
   exits 0 — real Postgres, `FakeGraphiti` filled past `LANDED_SCAN_DEPTH`, an INJECTED lookup
   (`{ lookup, deepRequeue }` options): (a) the saturated group is JUDGED — `deepResolvedGroups 1`,
   `saturatedGroups 0`, a landed row `confirmed` with its `episode_uuid` backfilled, a row missing
   one of three chunks counted in `partialItems` with the missing name in `partialDetail`;
   (b) ITEM IDENTITY: a row that SHRANK 3→1 (ledger `chunk_shas.length 1`, graph holds only
   `items:x#0..#2`) CONFIRMS and is neither held nor re-queued; a row that GREW 1→3 (ledger
   expects `#0..#2`, graph holds only the legacy bare `items:x`) CONFIRMS and is NOT counted
   partial — `landedState` reports `none` inside the confirmed branch, the documented
   hole-by-renaming under-count (`reconcile.ts:312-318`) — and the arm PROVES it is today's
   verdict by running the same fixture through the REST path (unsaturated) first and asserting
   the two summaries agree (no chunk-config arm — struck, see D1); (c) a never-landed
   row past the grace with `deepRequeue: false` is HELD — `deepRequeueHeld 1`, its id in
   `deepRequeueSample`, `reQueued 0`, `content_sha256` untouched; (d) the same row with
   `deepRequeue: true` is re-queued — `reQueued 1`, `content_sha256 = ''`, `first_seen_at`
   preserved (STALLSCOPE-1); (e) D2: a lookup returning `null` → today's verdict
   (`saturatedGroups 1, reQueued 0, confirmed 0`, ledger untouched); a lookup that THROWS → the
   same; (f) D5: the lookup is called with the ledger's `group_id` and ITEM ids; a present
   episode for a DIFFERENT item (`items:abcd` when the ledger holds `abc`) does not confirm;
   (g) D2b: a lookup returning NOTHING for an item the REST window confirms →
   `lookupMismatchGroups 1`, `saturatedGroups 1`, `deepResolvedGroups 0`, `reQueued 0` EVEN WITH
   `deepRequeue: true`, ledger untouched; a lookup consistent with the window but silent about
   other items is judged (subset, not equality).
2. `npm run test:datamechanics:iso test/datamechanics/graph-project.datamechanics.test.ts` exits 0
   with ONE consciously revised pin: the existing saturated-group arm (`:801-820`) keeps
   `reQueued 0` and the ledger row, and its `saturatedGroups 1` assertion now runs with the
   default lookup UNCONFIGURED (D5c pins `NEO4J_URL = ""` in the tier) — it becomes the D2 pin
   for the real default. The cleanup-leg saturation pin (`:844-874`) and the throttle pin
   (`:779-799`) stay green UNCHANGED.
3. `npm run test:neo4j` (after `npm run db:test:neo4j:up`; self-skips without `NEO4J_TEST`) exits 0
   with a new arm in `test/graph-neo4j-tier.test.ts`: real `(:Episodic {uuid, name, group_id})`
   nodes in two groups; `lookupItemEpisodes(groupA, [ids])` returns ONLY group A's chunks
   (`items:x`, `items:x#0`, `items:x#1` all present for one id), with uuids; a node in group B
   for the same id is absent; `items:abcd` is absent when asking for `abc`; `correction:<id>` is
   never returned; >500 ids chunk correctly (an id in the second chunk resolves).
4. `npx vitest run test/graph-recording-gate.test.ts test/graph-projection-run.test.ts
   test/graph-episode-lookup.test.ts` exits 0: `meta.deepResolvedGroups`, `meta.deepRequeueHeld`,
   `meta.deepRequeueHeldByGroup`, `meta.deepRequeueSample` (structured),
   `meta.lookupMismatchGroups` and `meta.deepRequeueEnabled` reach the durable row when non-zero
   (absent from a quiet row); `shouldRecordProjectionRun` is TRUE for `lookupMismatchGroups 1` alone; `RunMeta` renders an object value as compact
   JSON (unit, `components/admin/ingest-runs-panel`); `shouldRecordProjectionRun` is TRUE for
   `deepRequeueHeld 1` alone (either flag state), TRUE for `deepResolvedGroups 1` alone with
   `deepRequeueEnabled: false`, FALSE for `deepResolvedGroups 1` alone with `true`, TRUE for
   `saturatedGroups 1` alone (unchanged); the env parse: unset/`"false"`/`"1"`/`"yes"` → false,
   `"true"` → true; the lookup unit: batch 1 returns rows, batch 2 throws → the promise REJECTS and
   no rows are surfaced. Plus (dm, in AC1's file) an actual `ingest_runs` row exists after
   `recordIngestRun(projectionRunInput(summary))` for a held-only summary gated by the predicate —
   the end-to-end durable path, not just the mapper.
5. Mutations, verdicts verbatim in the PR: (a) make the saturated branch `continue` again (ignore
   the lookup) → AC1(a) reddens; (b) swallow the second batch's error in the lookup → AC4's unit
   reddens; (c) invert the `deepRequeue` gate → AC1(c) reddens; (d) drop the Cypher group term →
   AC3's cross-group arm AND the widened tier guard redden; (e) match by current expected names
   instead of the item stem → AC1(b)'s shrink arm reddens; (f) truthiness parse of the env →
   AC4's `"false"` arm reddens; (g) drop `deepRequeueHeld` from the gate → AC4 reddens;
   (h) disable the REST-window oracle → AC1(g) reddens; (i) drop a malformed row instead of
   throwing → the lookup unit reddens; (j) drop the deadline from `executeRead` → the read-timeout
   call-site pin reddens; (k) cap the sample at 5 again → the six-row arm reddens; (l) remove the
   per-source cap → the diversify unit reddens.
6. Full tiers green: `npm test` · dm iso (the graph set) · `npm run test:http:local` (the stacked
   PR runs only the gate workflows — the http tier is run locally and commented on the PR) ·
   `npm run check:docs` · `docs/ARCHITECTURE.md:115` gains the saturation + lookup prose.
   **Merge condition (round 2 L1):** after #629 merges, this PR is retargeted to `main` and the
   FULL required CI must run green on the retargeted head before the merge word — local http
   evidence is adequate while stacked, not as final merge evidence.
7. `npx vitest run test/graph-neo4j-read-timeout.test.ts test/ingest-runs-diversify.test.ts`
   exits 0: the deadline default/override/garbage arms + the `executeRead` call-site pin; the
   panel's per-source cap, its lift, and the single-source no-op.
8. `npx vitest run test/guards/graph-tier-filter.test.ts` exits 0 with the comment-stripping arm:
   a block whose only `group_id` term sits inside a `//` or `/* */` comment is reported missing.

## 4. Out of scope, named

- The tier-cleanup leg's 100,000-deep REST listing and `deleteItemEpisodes`' scan — they resolve
  names→uuids through `listEpisodes` today and keep doing so; a lookup-backed delete is its own
  slice (it changes an access-control latch: `docs/design/phase-c-per-project-graphs.md:55`
  builds partition suppression on `pending_delete` staying set while a scan is inconclusive).
- The hole-by-renaming class (`reconcile.ts:312-318`) — still uncounted, deliberately.
- Flipping `GRAPH_DEEP_REQUEUE` on — a human decision after reading the first passes' meta (D4).
- Persisting a per-row "judged absent since" so re-queue needs K consecutive absent passes by
  construction (schema) — the structural successor to D4's flag, filed only if measurement shows
  held rows are common.
- Duplicate-episode cleanup inside General (the amplification the stall already caused) — a
  different slice, needs the measurement this one restores.
