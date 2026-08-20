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
- **D2 — the watermark covers the FILES and COMMIT-PAGINATION legs ONLY, on PROVEN remote
  semantics; the ISSUES pass is NOT watermarked (REVISED at design round 2's blocker).**
  Round 2 showed the issues skip rode UNPROVEN GitHub semantics (assignee changes may not
  bump issue `updated_at` — community-reported stale payloads — and normalized tasks carry
  assignees), and the issues pass is the CHEAP leg anyway (~one paginated list per repo per
  tick; the 644-item corpus is dominated by the files pass's per-file content + last-commit
  fetches and the ~90d commit pagination). So: the issues pass runs EVERY tick exactly as
  today, and the cursor is `{ pushedAt, updatedAt, defaultBranch, configHash }` from ONE
  `GET /repos/{owner}/{repo}` — the files tree can change ONLY via a push (`pushed_at`) or a
  default-branch switch (`default_branch`, `updated_at`), and commits only via push: solid
  semantics, no false-negative surface. Equality on ALL parts → skip the files + commit-
  pagination legs; any inequality, absence, or probe ERROR → the full legs (fail toward
  freshness). NAMED BOUNDED RACE: a push landing in the same clock-second as the recorded
  `pushed_at` after the pass's fetch keeps equality and is missed until the next push —
  accepted, documented, heals on any later activity. The cursor is written ONLY after a
  fully-successful pass over that repo (a failed pass must not advance the watermark and
  orphan the delta).
- **D2b — `configHash` busts the cursor on config OR IDENTITY change (round 1 H2):** the
  hash covers the repo's `fileGlobs` + resolved history window + an IDENTITY-MAP hash. Both
  the files pass and the commit scan resolve authors at scan time
  (`buildIdentityMap`/`resolveMember`; `code_contributions.member_id`), and
  `reattributeItems` re-points ITEMS only — so on a quiet repo a new alias mapping would
  freeze `code_contributions` attribution forever behind a `pushed_at`-equal skip. An alias
  change busts the hash → full pass → the scan re-resolves. Over-triggering is the safe
  direction; alias edits are rare. THE HASH MUST BE DETERMINISTIC (round 2 M): the identity
  map is built in DB result order with no ORDER BY — the hash serializes SORTED entries, and
  a unit arm proves shuffled-equivalent inputs hash identically (a nondeterministic hash
  would make the watermark silently never skip — the vacuity failure).
- **D2d — the scan SPLITS; its existing writer keeps the metadata leg (REVISED at round 2 —
  the probe-body upsert would have added a SECOND writer to scanner-owned `codebases` rows
  and silently frozen `languages`, which needs its own API call):** `ingestGithubApiScan`'s
  metadata leg (`fetchRepoMeta` — the `/repos` + `/languages` pair, ~2 cheap calls/repo/tick,
  INCLUDING its existing scanner-owned no-op rule) runs EVERY tick unchanged; only the
  expensive commit PAGINATION sits behind the watermark. One writer, zero contract drift,
  metadata/star/language freshness identical to today.
- **D2e — cursor LIFECYCLE (rationale CORRECTED at round 2): unlinking a repo deletes its
  cursor row as lifecycle HYGIENE — the round-1 empty-corpus story was FALSE** (unlink never
  purges items; `github-link.ts`'s own comment says so — so a relink-then-skip serves the
  still-present corpus, which is CORRECT). The delete keeps cursor state from outliving the
  config that owns it; orphan rows would be inert but the delete is the stated contract. 
- **D2f — manual "sync now" BYPASSES the watermark (round 1 M, decided):**
  `runGithubIngestion` gains `force?: boolean`; BOTH manual callers pass `force: true` (the
  chat manual-sync path AND the admin "Run GitHub now" action — round 2 enumerated them);
  the scheduler path uses the watermark. The `githubRunning` singleton's silent
  `skipped: true` during a concurrent scheduler run is today's behavior, ACCEPTED and stated
  ("could not start — already running"). Pinned both directions.
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
- **D5 — no decoupling/parallelizing in this slice, and the fit claim is scoped HONESTLY
  (round 2):** QUIET github ticks fit with room (~1–2 min chain); a tick where github
  genuinely changed still full-passes (~19 min — bounded by real pushes, the work is then
  wanted); `graph_project` runs from its OWN scheduler, not inside this chain (round 2
  verified), so it does not stack. Decoupling/overlap stays out — revisitable if a busy-repo
  future re-measures differently.

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
   exits 0 — real-Postgres, stubbed GitHub API: after a first tick writes the cursor, a
   QUIET second tick SKIPS the files + commit-pagination legs (the stub records ZERO deep
   calls — the vacuity/not-invoked pin, round 2 M) while the ISSUES pass and the metadata
   leg both STILL run (their stub calls recorded — the not-watermarked contract, both
   directions); a bumped `pushed_at` (and separately a changed `default_branch` at equal
   `pushed_at`) runs the legs and advances the cursor only on success; a probe ERROR runs
   the full legs; a failed pass does NOT advance the cursor; a changed `fileGlobs` and a
   changed identity map each full-pass despite equal remote values (D2b); `force: true`
   full-passes despite an equal cursor (D2f); the issues pass, whenever it runs, receives
   the STORED window verbatim (D3 — the sinceIso pinned).
2. Same file — the cursor rows: written only by the module, keyed per repo, remote values
   stored verbatim (no clock arithmetic anywhere — asserted by shape).
3. `npx vitest run test/github-watermark-unit.test.ts` exits 0 — the pure decision
   (`shouldSkipRepo(cursor, probe, configHash)`): every combination of
   equal/unequal/absent/error inputs maps to the D2 truth table (skip ONLY on full
   equality); the identity/config hash is DETERMINISTIC (shuffled-equivalent inputs hash
   identically — round 2's vacuity guard).
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
