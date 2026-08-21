---
access: team
---

# RECONULL-1 — a failed group listing is counted, the listing body is validated, and nothing is written on a guess (re-scoped at design review: the oracle-free fall-through was DECLINED)

Deps: GRAPHSAT-1 (merged #633 — the per-item lookup, the REST-window oracle, the held/measurement
machinery this slice reuses). Build-with: fable / high (the failure direction is the same metered
re-push class GRAPHSAT-1 guarded). Reviewers: Codex gpt-5.6-sol on the spec and the diff; Fable on
the diff.

## 0. What and why

**The silent path.** `lib/graph/reconcile.ts:362-363`:
```ts
const episodes = await client.listEpisodes(groupId, LANDED_SCAN_DEPTH).catch(() => null);
if (episodes === null) continue;
```
A listing that throws — unreachable Graphiti, a non-2xx, or the client's 30 s abort
(`graphiti-client.ts:92`) — skips the group with **no summary field, no meta key, no gate signal,
no log line**. The same shape exists on the cleanup leg (`reconcile.ts:557-558`). The skip
direction is right (couldn't check ≠ never landed); the silence is the defect: a pass in which the
largest group was never judged is indistinguishable from a healthy quiet pass.

**Measured (prod, read-only, 2026-08-21).** The graphiti Railway service builds from this repo's
`graphiti/` directory, so a merge to `main` redeploys it: deployments at 04:45 and 05:18 PDT match
#633 and #634. After the 05:18 restart, General's `GET /episodes/aios_team?last_n=5000` went from
~8 s (the 11:37 pass: `reconcileMs 7,956`) to past the brain's 30 s abort — the 12:22 and 13:22
passes both show `reconcileMs ≈ 34 s` (30 s abort + the external group), `saturatedGroups 0`, no
`deepResolvedGroups`, `reconciled 4`: **General unjudged twice in a row**, legible ONLY because
GRAPHSAT-1's deep pass an hour earlier (`reconciled 2,605`) set a baseline. Graphiti's own log
shows the GET returning **200** — slow on a cold Neo4j page cache, not down. Over 14 days, 5 of 365
recorded runs carry the unjudged-quiet shape — a LOWER bound, since a pass with nothing to report
was mostly not recorded at all before GRAPHSAT-1's measurement gate.

**Why the timeout matters more now.** Before GRAPHSAT-1 a 5,000-episode listing that succeeded was
immediately discarded as "saturated"; the listing's only job today is to (a) tell saturation from
a small group and (b) feed the REST-window ORACLE that protects the lookup path. A listing that
times out loses both — and the larger the group grows, the slower the listing, the more often it
times out right when the lookup path matters most.

## 0b. Decidables — defaults stated for the design round to attack

- **D1 — count it, loudly.** A listing that throws increments `unreachableGroups` (landed leg) and
  `unreachableCleanupGroups` (cleanup leg); both ride `ReconcileSummary` → `GraphProjectionSummary`
  → `ingest_runs.meta` (when non-zero) → the scheduler log line, and `unreachableGroups` is a
  **recording-gate signal** (`shouldRecordProjectionRun`): "the largest group was not judged" is
  exactly the class the no-silent-caps rule exists for. One `console.warn` per group naming the
  error message (the abort reads as `The operation was aborted`; a 5xx carries its status). The
  warn does not leak content: group id + error text only.
- **D2 — NO oracle-free writes (Codex design round 1 BLOCKER — the draft's fall-through was
  DECLINED).** The draft judged an unreachable group via the per-item lookup without the
  REST-window oracle, claiming confirmation / uuid backfill / `partialItems` were "non-extracting,
  retry-safe". FALSE for the backfill: `episode_uuid` is "reconcile's confirm" for the arming
  latch (`arming.ts:137`) and the restriction-move `landedCopy` (`project.ts:1131`) — a
  wrong-but-reachable graph holding same-named episodes could backfill a false uuid and complete
  a move or latch a project while the real graph never received the copy. Holding re-queues does
  not contain that. So on a failed listing the group stays UNJUDGED — today's skip, now counted
  (D1). The lookup may run in **OBSERVE mode** only: no write of any kind; it reports
  `observeConfirmed` / `observeAbsent` counts for the group on the summary and meta so the operator
  can see "had we judged, N would confirm / M are absent" — visibility, never evidence. Observe
  mode runs only when `neo4jConfigured()` and costs ≤ 6 Cypher reads for General; it is skipped
  (not failed) when the lookup throws. Alternative rejected: a process-memory "last good oracle"
  — neither durable nor safe across topology changes; the extraction-health census reads the
  SAME Neo4j and is not independent.
- **D2b — the listing BODY is validated, because a malformed 200 is worse than a timeout (round 1
  HIGH).** `graphiti-client.listEpisodes` tolerantly turned `{}`, a scalar, or `{episodes:
  undefined}` into `[]` — and an EMPTY listing for a group with thousands of previously-confirmed
  rows takes the REST path, which has NO hold: every row past the grace reads never-landed and
  re-queues up to the cap, every pass. Now: the body must be a bare array or `{ episodes: array }`
  and every ref must carry a string `uuid` and `name`; anything else THROWS → `unreachableGroups`.
  And an empty array for a group whose ledger holds ≥ 1 row with a non-null `episode_uuid`
  (i.e. a row reconcile itself once confirmed) is a distinct signal: `emptyListingGroups++`, a
  recording-gate signal, logged as a possible mass disappearance — the bounded re-queue behaviour
  itself is unchanged in this slice (the throttle is the existing bound; the H7 comment in
  reconcile names this shape), because an actually-wiped graph SHOULD re-push and the slice's job
  is to make the event loud, not to change the recovery.
- **D3 — the deadline is an operator escape hatch; the default does NOT change (round 1 HIGH).**
  A longer timeout inside #629's lease + the process single-flight holds every later team for
  that long per slow group, so 60 s is NOT the new default. `listEpisodes` gains a per-call
  `{ timeoutMs }` override; reconcile passes `LANDED_LIST_TIMEOUT_MS` = env
  `GRAPH_LANDED_LIST_TIMEOUT_MS` or the client default (30 s). The cheaper lever is depth:
  `GRAPH_LANDED_SCAN_DEPTH` lower (1,000) makes the listing ~5× cheaper and the oracle still a
  valid (smaller) subset — but ONLY on an install with `NEO4J_URL` configured, because below the
  depth a group is judged by REST and above it by the lookup, and an install WITHOUT Neo4j would
  lose judging for every 1k–5k-episode group. So the default stays 5,000 (no silent regression for
  self-hosters without Neo4j), and ARCHITECTURE + `.env.example` record the recommendation:
  "with `NEO4J_URL` set, `GRAPH_LANDED_SCAN_DEPTH=1000` is the better steady state". The 100 /
  1,000 / 5,000 latency measurement Codex asked for cannot be taken from a laptop (Graphiti is
  internal-only); `reconcileMs` on the next passes after an operator lowers it IS that measurement.
- **D4 — no change to the REST saturation semantics or to the lookup.** A listing that SUCCEEDS
  behaves as it does after GRAPHSAT-1 (small → REST verdict; full → lookup with the oracle). Only
  the throw branch changes. This fence excludes nothing that needs a home: every behaviour it
  keeps is already shipped and pinned (`graph-project`, `graph-saturated-heal` dm suites); the two
  things deliberately not touched — a lookup-based cleanup and a smaller listing window — are
  listed in §4 with where they go.
- **D5 — graphiti redeploy-on-merge gets a TRACKED ticket, not a note (round 1 M2).** The repo
  records the service's root directory but no watch paths (`docs/RAILWAY-TEMPLATE.md:25`,
  `graphiti/railway.json`); Railway's root directory controls build context while watch paths
  control whether unrelated commits trigger a deploy, and the measured 04:45/05:18 deployments
  support the inference that none are set. A restart is worse than a cold cache: graphiti's worker
  queue is IN-MEMORY (`graphiti/README.md`), so accepted-but-unprocessed episodes are LOST on every
  brain merge — reconcile's re-queue is what heals that, hourly. Filed as **GRAPHDEPLOY-1**
  (operator: verify/set watch paths `graphiti/**` in the dashboard and record the live setting);
  not code, not this slice.

## 1. The surface table

| Surface | Change |
|---|---|
| `lib/graph/reconcile.ts` | throw branch → `unreachableGroups++`, warn, OBSERVE-mode lookup (counters only, no writes), `continue`; empty listing over a once-confirmed ledger → `emptyListingGroups++`, warn; cleanup leg throw → `unreachableCleanupGroups++`, warn, `continue`; the final pending-cleanups count query's error handled LOUDLY (it silently read as zero — round 1 M1); `LANDED_LIST_TIMEOUT_MS` passed per call |
| `lib/graph/graphiti-client.ts` | `listEpisodes(groupId, lastN, opts?: { timeoutMs })` — per-call override; STRICT body validation (bare array or `{episodes: array}`, string `uuid`/`name` per ref) else throw |
| `lib/graph/run.ts`, `projection-run.ts`, `scheduler.ts` | `unreachableGroups`, `unreachableCleanupGroups`, `emptyListingGroups`, `observeConfirmed`, `observeAbsent` ride summary → meta (when non-zero) → log; the first three are recording-gate signals (the cleanup one too — round 1 M1: the pending count it relied on can silently read zero) |
| `test/datamechanics/fake-graphiti.ts` | `failListFor: Set<groupId>` — `listEpisodes` throws for those groups (the double has `failDeletes`; this is the read-side sibling) |
| `.env.example` | `GRAPH_LANDED_LIST_TIMEOUT_MS`; the `GRAPH_LANDED_SCAN_DEPTH=1000`-with-Neo4j recommendation |
| `docs/ARCHITECTURE.md` | graph row: the unreachable/empty-listing signals, observe mode, the depth recommendation; deploy notes: GRAPHDEPLOY-1 |
| Schema | **NONE** |

## 2. Mechanism notes

- Observe mode reuses `lookupItemEpisodes` + `presenceFrom` and computes, per unreachable group,
  how many ledger item ids have a uuid in the result (`observeConfirmed`) and how many do not
  (`observeAbsent`); it touches no row and calls no `hold()`. `lookupMismatchGroups` cannot fire
  on this path (no window) — stated.
- Body validation lives in the client so EVERY caller (landed leg, cleanup leg,
  `deleteItemEpisodes`) gets the same contract; a malformed body is a thrown `Error` naming the
  shape, which each caller's existing `.catch` turns into its skip — now counted.
- Cleanup leg: no observe mode (it resolves uuids to DELETE; nothing to observe safely); it keeps
  its skip and gains the count. The final `pendingCleanups` re-read's `error` is no longer
  ignored: on error the summary carries `pendingCleanups: -1`? NO — a sentinel number in a count
  is the `[object Object]` class of legibility bug. On error the pass pushes an entry to
  `errors` (`reconcile: pending-cleanup count failed: …`), which already turns the run red and
  records it; the count stays the in-memory value from this pass.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/graph-unreachable-listing.datamechanics.test.ts`
   exits 0 — real Postgres, `FakeGraphiti` with `failListFor` / `malformedListFor` /
   `emptyListFor`, an injected lookup: (a) the landed listing THROWS for the team group →
   `unreachableGroups 1`, `saturatedGroups 0`, `deepResolvedGroups 0`, `confirmed 0` (external
   only), NO uuid backfilled, NO row changed, `reQueued 0` even with `deepRequeue: true`;
   observe counters: `observeConfirmed` = the landed items, `observeAbsent` = the never-landed
   ones; (b) with the lookup `null` (unconfigured): same verdict, observe counters absent;
   (c) MALFORMED body (`{}`, `{episodes: "oops"}`, a ref without `uuid`) → the client throws →
   `unreachableGroups 1`, nothing written (the old behaviour would have re-queued every row past
   the grace — pinned by asserting `reQueued 0` and every sha intact); (d) EMPTY body for a group
   whose ledger holds a once-confirmed row → `emptyListingGroups 1`, logged; the existing bounded
   re-queue proceeds as today (`reQueued` ≤ cap) — the event is loud, the recovery unchanged;
   (e) cleanup leg: a pending-delete row whose OLD-group listing throws → `unreachableCleanupGroups 1`,
   `cleaned 0`, `pendingCleanups 1`, flag intact; (f) a listing that SUCCEEDS (small group) yields
   today's REST verdict with every new counter 0/absent.
2. `npx vitest run test/graph-recording-gate.test.ts test/graph-projection-run.test.ts
   test/graphiti-client-listing.test.ts` exits 0: `unreachableGroups 1`, `unreachableCleanupGroups 1`
   and `emptyListingGroups 1` each record ALONE; observe counters are meta-only (not gate
   signals); all absent from a quiet row; the client: body validation arms (bare array ok,
   `{episodes:[…]}` ok, `{}` throws, scalar throws, `{episodes:"x"}` throws, ref without string
   uuid throws); the per-call timeout: an ABORT-AWARE fetch mock (rejects from the signal's
   `abort` listener) + fake timers advanced asynchronously → the call rejects at the override
   (e.g. 5 s), not at the 30 s default; the env parse: unset/`0`/garbage → the client default,
   `"90000"` → 90_000.
3. Existing graph dm suites green UNCHANGED (`graph-project`, `graph-saturated-heal`, reconcile
   suites) — D4.
4. Mutations, verdicts verbatim in the PR: (a) restore the bare `continue` (no count) → AC1(a)
   reddens; (b) let observe mode write the uuid backfill → AC1(a)'s "no uuid backfilled" reddens;
   (c) drop `unreachableGroups` from the gate → AC2 reddens; (d) make the client tolerant again
   (`{}` → `[]`) → AC1(c) reddens; (e) ignore the per-call timeout → AC2's abort arm reddens;
   (f) drop the cleanup-leg count → AC1(e) reddens; (g) drop the empty-listing signal → AC1(d)
   reddens.
5. `npm test` · dm iso (graph set) · `npm run test:http:local` · `npm run check:docs` green;
   ARCHITECTURE + `.env.example` updated; GRAPHDEPLOY-1 filed on the board.

## 4. Out of scope, named

- A lookup-based cleanup (purging old-group episodes by per-item uuid when the listing is slow) —
  it changes an access-control latch; its own slice.
- Reducing `GRAPH_LANDED_SCAN_DEPTH` now that the lookup judges saturated groups (a smaller,
  faster window + the oracle may be the better steady state) — an operator knob today; revisit
  with the timing data this slice makes visible.
- The graphiti redeploy-on-merge configuration → GRAPHDEPLOY-1 (D5).
- Any write on the unreachable path (the declined D2) — if an independent oracle for the
  lookup ever exists without a REST window, it is its own spec.
- GRAPHSAT-2 (persisted consecutive-absence) — unchanged, still the gate for enabling re-queue.
