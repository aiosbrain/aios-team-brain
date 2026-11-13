# AIO-1217 F4-E3 case 10 — independent affected evidence review

## 1. VERDICT

`QUALIFIED_PASS_FOR_NORMAL_E3_CHECKPOINT_PUSH_ONLY`

No blocker or HIGH finding. One MEDIUM coverage finding and six LOW observations follow. This was a semantic, read-only review: I recomputed no hash and reran no command, so every hash identity below is parent-reported or runner-recorded.

## 2. Findings

### MEDIUM-1 — resolver and fixture-support sources are not in the packet (confirmed)

- **Trigger:** the review asks that case 10's stop point "follow from the supplied source" through session, guard and resolver. Case 10's own `SOURCE FACTS` (fixture `:2497-2506`) cite `lib/integrations/read.ts:72-73`, `postgres/schema.sql:124`, `test/datamechanics/helpers.ts:103` and `test/datamechanics/setup.ts:66-77`.
- **Expected:** those sources are inspectable.
- **Actual:** only `admission/09-guard.ts` is supplied. The stop point is source-derivable to `guard.ts:49-52` (session user, server client, `resolveIntegrationsAdmin`) and `actions.ts:88-89` (null verdict returns before `adminClient()`). The resolver's null-team return before the member read is **NOT VERIFIED by source**.
- **What stands in its place:**
  - Executed traces on both layouts show the single `teams` lookup answering zero rows and nothing after it (candidate records 39 and 41, reference records 33 and 35).
  - The fixture mocks none of guard, session, resolver or posture. Its only seams are `next/headers`, `next/cache`, the two client factories, and pass-through wrappers on `reconcile` and `crypto`.
  - Both composite maps record the same `lib/integrations/read.ts` hash, `d9967cfc…`.
- **Acceptance impact:** none on this push, because the behaviour is observed rather than inferred. The four line citations cannot be credited as source-reviewed.
- **Request:** add `lib/integrations/read.ts`, `lib/auth/session.ts`, `lib/auth/pg-session.ts`, `lib/access/posture.ts`, `lib/auth/admin-access.ts`, `test/datamechanics/helpers.ts`, `test/datamechanics/setup.ts` and the `teams` excerpt of `postgres/schema.sql` to the next packet that must credit source claims. If the coordinator's gate requires source derivation before push, these files are the smallest missing evidence.

### LOW observations (confirmed, non-blocking)

- **L1 — stale committed prose.** The fixture still says `Run status. NOT RUN … Replace this paragraph` (`:196-201`). Two TODOs still say "NEITHER a RED run NOR any mutant has been observed" and "a slug that names no team … not exercised" (`:2689`, `:2701`). Case 10's comment discloses this. Do not edit it in this push, since that would change the frozen fixture hash.
- **L2 — the campaign's tree diff is one-directional** (`f4-e3-paired-parent-campaign.py:35`). `loadedTreeFileHashes` is `git ls-files`, not the modules actually loaded, and `node_modules` is a shared unhashed symlink target. I closed the path-set gap by count; see the two-owner answer in section 4.
- **L3 — `actualGitHead` is copied from the request, not read back.** The runner's own `git rev-parse HEAD` records `9cd35756…` in both provenance files, so rely on those.
- **L4 — the lint and typecheck runner is not in the packet.** Both ran under `run_check.py` (`runnerSha256 9252586f…`), which is not among the 72 inputs, and neither run has start or end timestamps.
- **L5 — the helper accepts any nonzero exit for the reference.** That the failures are discriminating comes from `f4e3_reference.result.json` (`exit: 1`, test fingerprint unchanged) and the log, not from the exit class.
- **L6 — `originalWorktreeUnchanged` is HEAD plus `git status --porcelain` only.** Ignored paths such as the shared `node_modules` cache are not covered.

## 3. Coverage ledger

**Read in full**
- `admission/01`, `02`, `05`, `09`, `11`, `12`.
- `admission/04` (790 lines, read in four pages after the tool's 25k-token cap).
- Both manifests and `parent-launch-request.json`.
- The raw patch, and the post-patch fixture lines 1–2715 (lines 2469–2667 via the patch).
- `source/app/…/actions.ts` and `source/lib/pm-sync/reconcile.ts`.
- All three `runner/` files and the execution request.
- Both vitest logs.
- Both `result`, `provenance`, `environment` and `parent-command.log` sets.
- Lint and typecheck result, provenance and log.
- Checkpoint result and log.
- Builder final, status and parent-capture; admission status, final and single-retry; auth diagnostic; v9 upload result.

**Read in part**
- `reference/owner-0.ts:48-97` and `reference/owner-1.ts:70-107`.
- `project.ts:96-150`, `linear.ts:96-195` and `262-281`, `linear-client.ts:36-105`.
- `admission/06` lines 2448–2467.

**Grep only**
- `plane.ts`, `plane-client.ts`, `inbound.ts`, `provider.ts`, `index.ts`, `runs.ts`, `after-write.ts`, `work-keys.ts`.
- `admission/10`.
- Both `composite-runtime.json` files: header fields, 65 path hashes each, and entry counts.
- `f4-e3-paired-parent.result.json`: top-level and per-run fields, map line ranges.

**JSONL records**
- Read whole and compared before against after by inspection, not a mechanical diff: candidate records 39 and 40, reference record 33.
- For all 41 candidate and 35 reference records I extracted bounded patterns:
  - outcome, `acquired`, `seams`, `revalidated`;
  - trace tails after the owner returned;
  - `answered` objects;
  - every `task_pm_links` update with its bound values;
  - reconcile audit rows in the snapshots;
  - integration `disabled` and null-ciphertext states;
  - negative searches for refused statements, transport violations, tripwires, rejections, `ingest_runs` rows and any seen status on team B's link (zero hits in both files).
- Candidate record 41 and reference records 34 and 35 were checked by pattern, not read whole.

**Not inspected**
- Files that the manifest lists as hash-identical to ones I read: `admission/07`, `admission/08`, `candidate/owner-0.ts`, `candidate/owner-1.ts`, four runner copies, and the duplicate copies of v9 (`source/docs/design/…`), the Astra disposition and the E2 push record under `evidence/`.
- About 2,185 of the 2,250 per-path hash equalities.
- Whole-row before/after equality for the twelve candidate unavailable records and for the eight non-pass tables in case 9. Those rest on the fixture's deep-equality assertions passing, plus the patterns above.

**Tool truncation:** one Grep returned `[Omitted long matching line]` for three records. I replaced it with bounded patterns and full-line reads; nothing stayed unreadable.

## 4. Explicit answers

**Patch.** One hunk, `@@ -2457,6 +2457,220 @@`, adding 214 lines at 2460–2673 between case 9's closing `});` and the `// Each TODO…` line. Nothing outside it is altered. The checkpoint log agrees: `1 file changed, 214 insertions(+)`.

**Case 10, candidate (records 39–41) and reference (records 33–35) — passes on both.**
- **First refusal:**
  - Outcome `{ok:false,error:"admins only"}`, `acquired {server:1,admin:0}`, `seams {}`, `revalidated []`.
  - Trace is exactly: cookie read, server client, `teams` by slug with `rows:0`.
  - The only bound statement is `SELECT id FROM teams WHERE slug = $1` with the unknown slug.
  - The snapshot holds two teams, neither with that slug.
  - Alice is `admin`, `active`, `tier team`, and in her team's builtin Everyone group.
  - All ten tables are equal before and after.
- **Control, same session at team A's slug:**
  - Guard reads on `teams`, `members` and `group_members`, one row each, then the service client.
  - One integrations row and one decrypt of team A's secret.
  - Link read answering 3 rows, then three reads: `ProjectionBootstrap`, `ProjectionMembers`, `ProjectionIssues`.
  - Two link updates (`Done`, `In Progress`), then owner return, one audit insert, one revalidation.
- **Repeat:** same trace and same single bound statement. Link statuses, link timestamps and the one reconcile audit row are identical before and after.
- **Transport boundary:** the fixture records only the operation name and variables that reached global `fetch`. It does not establish live-provider authorization, service semantics, other transports, pagination or Next action-wire behaviour.

**Case 9, candidate (36–38) and reference (30–32) — passes on both.**
- Reported `seenUpdated` is 2, then 1, then 0, with three reads on every call.
- The middle call issues exactly one update, on the link the first call set to `Done`.
- Only that link's `updated_at` moves: `.148→.167` on the candidate, `.379→.4` on the reference.
- The rerun issues no update and preserves both timestamps.
- Audit ids 5, 6 and 7 carry `seenUpdated` 2, 1 and 0, each inserted after the owner returned and before the revalidation.
- Team B's link never gains a seen status, and `ingest_runs` is empty throughout.
- Tasks, integrations and primary configuration unchanged rests on the passed `besidesPass` assertion.

**Admitted, no-primary and Plane-unsupported controls.** Cases 1, 2, 3, 5, 6 (×2), 7 (×2) and 8 (×2) pass on both layouts. Plane-unsupported answers are unmarked and still audit and revalidate; that is preserved behaviour, not inbound-support credit.

**Six reference failures.** Reference records 10, 12, 14, 16, 18, 20 are Linear then Plane, each missing, disabled, secret-less; the stored states are confirmed from the snapshots. Each shows:
- an owner answer without `notRunReason`;
- public `ok:true` with `seenUpdated:0`;
- an audit insert and a revalidation after the owner returned;
- one new `team.reconcile_divergence` row;
- no `fetch` and no link update.

All six fail at the first `reach` assertion (`fixture:2056`). **The six reference repeats are NOT REACHED**: the reference has 35 records against the candidate's 41, and no second record exists per cell.

**Twelve candidate refusals.** Candidate records 10–11, 13–14, 16–17, 19–20, 22–23 and 25–26 each show:
- the two-key `primary PM integration is unavailable` outcome;
- an owner answer carrying `notRunReason:"integration_unavailable"`;
- a trace that ends at the owner's return;
- no audit row, revalidation, `fetch`, link update or run.

**Two-owner-only delta.** Each map has 2,250 entries (parent result lines 43–2292 and 2337–4586; 2,262 hash lines per composite file, being 2 owners, 2,250 paths and 10 artifacts). Because the counts are equal and the parent's assertion passed, the path sets are equal.
- The only recorded differences are `lib/pm-sync/reconcile.ts` (`19e25718…` vs `9cad6dcd…`) and `app/t/[team]/admin/pm-sync/actions.ts` (`b934a504…` vs `85fe8b5c…`). These match the frozen owner files.
- The reference owners lack the marker and the marker check, by direct reading.
- Fixture, vitest config, package-lock, dependency target, runner hash and environment are recorded identical.
- The candidate layout's production fingerprint `22b1b182…` equals the checkpoint's.
- The reference is a composite, not a pristine checkout.

**Harness and runner provenance.**
- Execution was serialized: reference 02:14:41–02:15:00Z, then candidate 02:15:01–02:15:14Z.
- The helper takes five arguments and invokes `pg` directly followed by the fixture, with no extra separator.
- The helper cleans the recorder file, checks fixture and runner hashes, and enforces the exit class.
- The runner allowlists the tier, the environment and the single relative recorder directory.

**Checkpoint.** `2437df69…`, `pushed:false`, `verified:false`, recorded at 02:09:06Z.

**Lint and typecheck.** `npx eslint <fixture>` exit 0 with an empty log, and `npm run typecheck` exit 0. Both are at head `2437df69…` with production and test fingerprints unchanged. The empty lint log shows only that nothing was printed. See L4.

**Historical block.** Unchanged and BLOCKED under the Astra disposition.

**Uncredited, preserved as listed in the prompt:**
- pre-edit caller census and contemporaneous runtime admission;
- the permanently disclosed missed RED-before-implementation chronology;
- the six reference repeats;
- the 13 TODOs and every F4-E3 arm case 10 does not supply;
- E4 whole acceptance and the remaining E1–E6, caller, mutation and final-validation obligations;
- E6 rendered UI, browser and Server Action wire coverage;
- live provider behaviour, alternate transports, pagination, timing or existence-oracle claims, tables outside the ten, and concurrency or revocation;
- full 95-action, 15-connection, 14-AC, lookup-error-leg, docs, build and full-suite coverage;
- fresh final Astra HIGH and blind GPT-6.1 Sol HIGH reviews;
- PR, merge, main, deployment, release and Done.

I add one: the packet does not relate runtime base `9cd35756…` to v9's pinned candidate `cd0387e8…`.

## 5. What this verdict authorizes

It authorizes only the parent to run the repository's normal review gate and then the checkpoint, push and independent remote-readback lifecycle for this E3-only snapshot `2437df69…`. It does not itself push, waive any gate, reset cadence, admit source or runtime work, accept E4, E6 or the task, or authorize PR, merge or Done.