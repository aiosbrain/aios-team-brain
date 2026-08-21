---
access: team
---

# RECONULL-1 — a failed group listing is counted, and (in measurement mode) judged anyway

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
- **D2 — a failed listing falls through to the per-item lookup, in MEASUREMENT MODE ONLY.** When
  the listing throws, the group is judged via `lookupItemEpisodes` exactly as a saturated group
  is, with one difference: there is no REST window, so the oracle (GRAPHSAT-1 D2b) is vacuous —
  and WITHOUT the oracle the lookup path must never re-push. So on the unreachable path the
  never-landed verdict is HELD regardless of `GRAPH_DEEP_REQUEUE` (counted under
  `deepRequeueHeld` / `deepRequeueHeldByGroup` / the sample as today, plus `unreachableGroups`
  names why). Confirmation, uuid backfill and `partialItems` — the non-extracting, retry-safe
  writes — proceed. Rationale: a slow Graphiti must not switch off confirmation of a group that
  a healthy Neo4j can judge; and the one action that is irreversible (a re-push) keeps the
  stronger precondition (a window-confirmed oracle). Alternative considered and rejected: skip
  the group entirely but count it — simpler, but it leaves General unjudged for as long as its
  listing is slow, which (D0) is precisely when the group is largest. Alternative rejected: run
  the lookup AND re-queue when the flag is on — the flag's enable criteria (GRAPHSAT-1 D4) assume
  the oracle; this path has none.
- **D3 — the listing's deadline is reconcile's to own, not the client's default.** The client's
  30 s is a per-call default sized for pushes; a 5,000-episode listing on a cold graph is a
  different call. `LANDED_LIST_TIMEOUT_MS` (env `GRAPH_LANDED_LIST_TIMEOUT_MS`, default **60 s**,
  `0`/blank/garbage → the default) is passed per call (`listEpisodes(groupId, depth, { timeoutMs })`
  — a new optional third argument on the client, default unchanged for every other caller). The
  deadline still exists (a hung Graphiti must not strand #629's lease); it is just sized for the
  call. Measured basis: 8 s warm; the cold case exceeded 30 s twice; 60 s is a 2× margin over the
  abort that failed, not a fit to one observation — and with D2 in place a timeout is no longer a
  lost pass, so the constant is a latency knob, not a correctness one.
- **D4 — no change to the REST saturation semantics or to the lookup.** A listing that SUCCEEDS
  behaves byte-for-byte as after GRAPHSAT-1 (small → REST verdict; full → lookup with the oracle).
  Only the throw branch changes.
- **D5 — graphiti redeploy-on-merge is NAMED, not fixed here.** The graphiti service rebuilding on
  every brain merge is a Railway root-directory/watch-path configuration, not code; it is recorded
  (ARCHITECTURE deploy notes) as the cause of the cold-cache restarts and left to an operator
  decision (watch paths = `graphiti/**`). Out of scope.

## 1. The surface table

| Surface | Change |
|---|---|
| `lib/graph/reconcile.ts` | throw branch → `unreachableGroups++`, warn, fall through to the lookup with `oracleVacuous = true` → held regardless of flag; cleanup leg throw → `unreachableCleanupGroups++`, warn, `continue` (unchanged behaviour, now counted); `LANDED_LIST_TIMEOUT_MS` |
| `lib/graph/graphiti-client.ts` | `listEpisodes(groupId, lastN, opts?: { timeoutMs })` — per-call override; `request` takes the override; defaults unchanged |
| `lib/graph/run.ts`, `projection-run.ts`, `scheduler.ts` | the two counters ride summary → meta (when non-zero) → log; `unreachableGroups` joins the gate |
| `test/datamechanics/fake-graphiti.ts` | `failListFor: Set<groupId>` — `listEpisodes` throws for those groups (the double has `failDeletes`; this is the read-side sibling) |
| `.env.example` | `GRAPH_LANDED_LIST_TIMEOUT_MS` |
| `docs/ARCHITECTURE.md` | graph row: the unreachable path + the redeploy-on-merge note |
| Schema | **NONE** |

## 2. Mechanism notes

- The unreachable path shares the saturated path's code after the branch: one `judgeViaLookup`
  step with a flag `{ oracle: "window" | "none" }`; with `"none"`, `hold()` is unconditional.
  The existing `lookupMismatchGroups` cannot fire on this path (no window) — stated.
- `deepRequeueEnabled` on the summary keeps meaning "the mode the run executed"; a held row on
  the unreachable path while the flag is on is legible as `unreachableGroups > 0` on the same row.
- Cleanup leg: falling through to a lookup-based purge is NOT done (it changes the
  partition-suppression latch — `phase-c-per-project-graphs.md:55`); the leg keeps its skip and
  gains the count. Named in §4 for the follow-up.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/graph-unreachable-listing.datamechanics.test.ts`
   exits 0 — real Postgres, `FakeGraphiti` with `failListFor`, an injected lookup: (a) the
   landed listing throws for the team group → `unreachableGroups 1`, `saturatedGroups 0`,
   `deepResolvedGroups 1`, a landed row `confirmed` with its uuid backfilled, a partial row counted;
   (b) a never-landed row past the grace is HELD with `deepRequeue: true` (no oracle → no re-push),
   `reQueued 0`, its identity in the sample; (c) with the lookup `null` (unconfigured) the throw
   branch counts `unreachableGroups 1` and judges nothing — today's verdict plus the count;
   (d) the cleanup leg: a pending-delete row whose OLD-group listing throws → `unreachableCleanupGroups 1`,
   `cleaned 0`, `pendingCleanups 1`, the flag intact (today's behaviour, now counted); (e) a listing
   that SUCCEEDS (small group) is byte-identical to before: `unreachableGroups 0`, the REST verdict.
2. `npx vitest run test/graph-recording-gate.test.ts test/graph-projection-run.test.ts
   test/graphiti-client-timeout.test.ts` exits 0: `unreachableGroups 1` alone records;
   `unreachableCleanupGroups` rides meta when non-zero and is NOT a gate signal (the cleanup leg
   already gates on `pendingCleanups`); both keys absent from a quiet row; `listEpisodes` passes a
   per-call `timeoutMs` to the abort controller (a mocked `fetch` that never resolves is aborted
   at the override, not the default — pinned with fake timers); the env parse: unset/`0`/garbage →
   60_000, `"90000"` → 90_000.
3. Existing graph dm suites green UNCHANGED (`graph-project`, `graph-saturated-heal`, reconcile
   suites) — D4.
4. Mutations, verdicts verbatim in the PR: (a) restore `continue` on the throw branch → AC1(a)
   reddens; (b) make the unreachable path honour the flag (re-push with no oracle) → AC1(b)
   reddens; (c) drop `unreachableGroups` from the gate → AC2 reddens; (d) ignore the per-call
   timeout in the client → AC2's abort arm reddens; (e) drop the cleanup-leg count → AC1(d) reddens.
5. `npm test` · dm iso (graph set) · `npm run test:http:local` · `npm run check:docs` green;
   ARCHITECTURE updated.

## 4. Out of scope, named

- A lookup-based cleanup (purging old-group episodes by per-item uuid when the listing is slow) —
  it changes an access-control latch; its own slice.
- Reducing `GRAPH_LANDED_SCAN_DEPTH` now that the lookup judges saturated groups (a smaller,
  faster window + the oracle may be the better steady state) — an operator knob today; revisit
  with the timing data this slice makes visible.
- The graphiti redeploy-on-merge configuration (D5).
- GRAPHSAT-2 (persisted consecutive-absence) — unchanged, still the gate for enabling re-queue.
