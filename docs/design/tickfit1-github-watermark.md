---
access: team
---

# TICKFIT-1 — make the ingest tick fit its interval: the github change-watermark

## 0. What and why

**What:** the github ingest stage learns to prove a repo unchanged CHEAPLY (a per-repo remote
watermark) and skip its three full passes when it can — so a quiet tick's github stage costs
seconds, not 19 minutes, and the deep legs (meeting notes, backfill, graph, dense) stop
queuing behind connector I/O that discovers nothing.

**Why (recorded + measured):** TICKSTALL-2's cut slice 1 — *"the chain-level problem: github
at 18.6 min average, the tick's ~42 min of total average work against a 30-minute interval …
named, measured, left to its own spec"* (`docs/design/backfill-sweep-o-backlog.md:152-155`).
The TICKSTALL-2 row is marked done though only slice A shipped; TICKFIT-1 is the honest
reopening of the named remainder.

**Measured terrain (prod, read-only, 2026-08-19/20):**
- `github`: **19.1 min avg over the last 24h (45 runs), dead stable (19.0–19.8)** — and every
  recent run reports **0 created / 0 updated / 644 unchanged**. ~14 hours of chain wall-time
  per day spent re-discovering an unchanged corpus.
- The corpus: **3 repos** (`aios-team-brain`, `aios-workspace`, `aios-alpha.github.io`) — the
  watermark's leverage is total: a quiet tick becomes ~4 probe calls.
- The rest of the chain TODAY (24h avgs): `graph_project` 10.5 (its own cadence, 27 runs/day),
  `dense` 0.4, `slack` 0.4, `linear` 0.2, `context_backfill` **0.1** (slice A healed it — the
  3-day window's 60-min tail was pre-slice runs; the Aug-18 record's backfill numbers are
  STALE), `meeting_notes` 0.1, everything else ≤0.1. With github fixed, a typical tick sums
  to ~1–2 min (~12 on graph-cadence ticks) — the chain FITS the 30-min interval with room.
- The mechanism of the waste (`lib/ingest/run.ts:598-660`): per repo per tick, THREE
  unconditional full passes — (1) `fetchGithubRepoIssues` over the stored history window,
  (2) `fetchGithubRepoFiles`, a full tree walk that fetches files to learn their shas are
  unchanged, (3) `ingestGithubApiScan`, a ~90d commit re-pagination. No change detection
  anywhere.

**Ticketing:** row `TICKFIT-1`; PR carries `AIOS-Work: TICKFIT-1`.
**Governing records:** the TICKSTALL-2 cut (above); AIO-798/AIO-807's history-anchor rulings
(the constraints this slice must NOT disturb). **Deps:** none open. **Schema: one additive
table** (D1). **Build with:** fable / high.

## 0b. Decidables — defaults stated for the design review to attack

- **D1 — the watermark store is a tiny keyed table, `connector_cursors`**
  (`team_id, key text, cursor jsonb, updated_at` — PK `(team_id, key)`; key e.g.
  `github:<owner>/<repo>`), written ONLY by the ingest stage that owns the probe. NOT
  `integrations.config` (operator-owned config — the sync writer mutating it conflates two
  ownerships), NOT `projects.last_synced_at` (our clock, wrong semantics — see D2), NOT
  `ingest_runs.meta` (per-run log, not state). Additive migration + schema.sql mirror (the
  ADD-COLUMN rule does not apply — new table). Lowest-shared-layer: any future connector can
  use the same store.
- **D2 — the cursor stores the REMOTE's own values, compared by EQUALITY — never our clock
  (REVISED at design round 1: the repo probe carries THREE values, and the metadata refresh
  rides the probe itself).** For github: `{ pushedAt, updatedAt, defaultBranch,
  issuesUpdatedAt, configHash }`. ONE `GET /repos/{owner}/{repo}` yields `pushed_at`,
  `updated_at`, AND `default_branch` (plus description/language/stars — see D2d); the
  files+commits SKIP requires equality on ALL THREE (round 1 H1: a default-branch switch or
  settings change does not bump `pushed_at` — `updated_at`/`default_branch` catch it). The
  issues pass skips iff the newest `/issues?state=all&sort=updated&direction=desc&per_page=1`
  `updated_at` equals the stored `issuesUpdatedAt`. That probe surface includes PRs (a
  SUPERSET of the normalized issues-only set) — deliberately: a superset watermark can only
  produce FALSE POSITIVES (PR churn runs a redundant issues pass — fail toward freshness,
  cheap), never a miss, because `updated_at` is a now-stamp — any later change strictly
  exceeds the prior maximum (round 1's miss scenario requires a backdated update, which user
  actions cannot produce). NAMED BOUNDED RACE: an update landing in the SAME SECOND as the
  cursor's value after the pass's fetch keeps equality and is missed until the next real
  change — accepted and documented (the F3-style over/under bound: heals on any subsequent
  activity; the window is one clock second per pass). Any inequality, absence, or probe
  ERROR → the FULL pass. The cursor is written ONLY after a fully-successful pass over that
  repo (a failed pass must not advance the watermark and orphan the delta).
- **D2b — `configHash` busts the cursor on config OR IDENTITY change (round 1 H2):** the
  hash covers the repo's `fileGlobs` + resolved history window + an IDENTITY-MAP hash. Both
  the files pass and the commit scan resolve authors at scan time
  (`buildIdentityMap`/`resolveMember`; `code_contributions.member_id`), and
  `reattributeItems` re-points ITEMS only — so on a quiet repo a new alias mapping would
  freeze `code_contributions` attribution forever behind a `pushed_at`-equal skip. An alias
  change busts the hash → full pass → the scan re-resolves. Over-triggering is the safe
  direction; alias edits are rare.
- **D2d — the probe IS the metadata refresh (round 1 H1's second half, folded as a WIN):**
  `ingestGithubApiScan` writes repo metadata (description, homepage, language, stars, forks,
  archive status, default_branch) that `pushed_at` does not track. The probe response
  ALREADY CARRIES all of it — so the metadata upsert runs from the probe body EVERY tick at
  zero extra API cost, and only the expensive legs (tree walk, file fetches, commit
  pagination) sit behind the watermark. Star/metadata freshness is therefore BETTER than
  today's, not worse.
- **D2e — cursor LIFECYCLE (round 1 M): unlinking a repo DELETES its cursor row** (the
  unlink path already prunes `integrations.config.repoHistory` — it gains the cursor delete).
  The scenario that makes this load-bearing: unlink purges the repo's items (the
  `lib/ingest/purge` removal path); a relink with an unchanged remote would otherwise skip
  over an EMPTY corpus and never re-ingest until the remote changes. Orphan rows from
  pre-delete eras are harmless (absent config → the repo is never iterated) but the delete
  is the contract. 
- **D2f — manual "sync now" BYPASSES the watermark (round 1 M, decided):**
  `runGithubIngestion` gains `force?: boolean`; the manual-sync path passes `force: true`
  (an operator clicking sync expects a real pass — probe-verified "up to date" is not what
  the button promises); the scheduler path uses the watermark. Pinned both directions.
- **D3 — the stored history ANCHOR is untouched, stated as a hard constraint.** The issues
  pass, when it RUNS, still fetches the full stored window verbatim (`history?.sinceIso`) and
  diff-syncs exactly as today — the recorded plan-review blocker (a recomputed window
  diff-deletes imported issues as they age out, guard-pinned) is not grazed. The watermark
  only decides WHETHER the pass runs, never what window it covers.
- **D4 — run-summary honesty:** a skipped repo is reported as skipped (`meta.skippedRepos`
  = count + `meta.skippedRepoNames` = a comma-joined string — the admin Recent Runs panel
  renders generic meta via `String(v)`, so both shapes display legibly; round 1 L), not
  silently absent — and NOT counted into `unchanged` (which counts diff-synced
  rows; a skip diff-syncs nothing). The `0/0/644` shape becomes `0/0/0 + skipped:3` on a
  quiet tick; dashboards/queries reading `unchanged` as "how much was scanned" see the
  honest new number. The ingest health card's staleness logic must be checked against the
  new shape (a skip is a HEALTHY outcome, not a stalled sync).
- **D5 — no decoupling/parallelizing in this slice.** With the watermark, the measured chain
  fits with room; moving github to its own timer or overlapping connectors is complexity the
  numbers no longer demand. Named out, revisitable if a busy-repo future re-measures
  differently.

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| `runGithubIngestion` per-repo loop (lib/ingest/run.ts:598-660) | three unconditional full passes per repo per tick | probe-first: resolve the repo's remote watermark (+1 issues probe); equality on ALL parts + configHash → record the skip and continue; any inequality/absence/error → today's full passes, then write the cursor |
| the cursor store | ABSENT | `connector_cursors` (D1), single-writer = the github stage; read/write via one small module (`lib/ingest/cursors.ts`) |
| run summary / `ingest_runs` | `unchanged` conflates "diff-synced, no change" with everything | `meta.skippedRepos`; counts untouched for real passes (D4) |
| ingest health card / staleness readers | reads run rows | verified against the skip shape (a skipped-quiet tick is healthy) — checked, changed only if a reader misreads skips as stalls |
| schema | — | `postgres/schema.sql` + additive migration: the new table only |

## 2. Mechanism notes

- **Fail directions, exhaustively:** probe API error → full pass; cursor read error → full
  pass; cursor WRITE error → logged, next tick full-passes again (over-work, never
  under-work); a pass with ANY per-repo error → cursor NOT advanced for that repo. The only
  path to a skip is: cursor present ∧ configHash match ∧ both remote values equal.
- **Force-pushes/rebases** bump `pushed_at` → full pass (correct). **Issue edits/comments**
  bump the probe's `updated_at` → issues pass runs. **Repo renames/transfers** change the
  cursor key → absent cursor → full pass.
- **Rate-limit accounting:** the probes cost 2 API calls per repo per tick (~96/repo/day),
  replacing hundreds of tree/content/commit calls — strictly cheaper in every regime.
- **One writer:** `lib/ingest/cursors.ts` is the only writer of `connector_cursors`
  (guarded the usual way if a guard is warranted — a real contract: the probe's correctness
  depends on the cursor only advancing after full success).

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/github-watermark.datamechanics.test.ts`
   exits 0 — real-Postgres, stubbed GitHub API: a repo whose probes equal the stored cursor
   SKIPS all three passes (the stub records zero deep calls — the not-invoked pin) and the
   run reports it in `meta.skippedRepos`; a bumped `pushed_at` runs files+commits (and
   advances the cursor only on success); a bumped issues `updated_at` runs the issues pass
   with the STORED window verbatim (D3 — the sinceIso the stub receives equals the anchor,
   pinned); a probe ERROR runs the full passes (fail-toward-freshness, both probe arms); a
   failed pass does NOT advance the cursor (the next tick re-runs); a changed `fileGlobs`
   full-passes despite equal remote values (D2b).
2. Same file — the cursor rows: written only by the module, keyed per repo, remote values
   stored verbatim (no clock arithmetic anywhere — asserted by shape).
3. `npx vitest run test/github-watermark-unit.test.ts` exits 0 — the pure decision
   (`shouldSkipRepo(cursor, probes, configHash)`): every combination of
   equal/unequal/absent/error inputs maps to the D2 truth table (skip ONLY on full equality).
4. Mutations, verdicts verbatim in the PR: (a) force the skip decision to `true` → the
   bumped-`pushed_at` dm arm reddens (a change was skipped); (b) advance the cursor on a
   FAILED pass → the failed-pass dm arm reddens; (c) drop the configHash conjunct → the
   glob-change arm reddens.
5. Full tiers green: `npm test` · dm iso (tolerated: the pre-named TZ artifact + the known
   timeout-flake class, standalone-probed) · `npm run test:http:local` · `npm run check:docs`
   · lint · tsc; migration replay proven by `npm run db:test:up` (from-zero + replay);
   ARCHITECTURE gains the cursor-store row + the sources-of-truth entry; the tick's
   docstring names the watermark.

## 4. Out of scope, named

Decoupling github to its own timer / connector parallelism (D5 — the measured chain fits
without it); per-PASS timing instrumentation inside the github stage (worth having, its own
tiny slice if wanted); applying the watermark to slack/linear (already sub-minute — no need,
the store is ready for them); the `graph_project` 10.5-min stage (its own cadence, separate
record); the EXCLSHADOW-1 repair and the timeline-summary heal (declined by the operator
today, recorded); the TICKSTALL-2 row's done-status hygiene (this row supersedes it by
reference).
