# AIO-1170 recovery and resume record

Last updated: 2026-10-24. The newest current-state section governs. Older sections are preserved as historical stop records and may describe gates that have since been cleared. This is the tracked recovery record for draft [PR 714](https://github.com/aiosbrain/aios-team-brain/pull/714), targeting `staging`. It does not claim AC-02 or AIO-1170 complete.

## Current state — 2026-10-24, invalid-cursor GREEN checkpoint

This section is newer than the RED section below and supersedes its "exact next stage" bullet.

- **Production checkpoint `4c9d2bdb`**, on the remotely verified RED recovery head `765974b9`. It is the sole production commit: only `lib/ingest/slack-channel-state.ts` and `lib/ingest/slack-source-discovery.ts` changed (+120/−62). The reviewed RED tests are unchanged.
- **State writer:** the existing `restartSlackChannelScan` export now returns a typed `subdivided`, `restarted` or `refused`.
  - The complete channel fence is checked by a locking read and repeated in the write.
  - A wide segment gets the exact BigInt midpoint on the same row: S becomes M + 1 µs and U is retained.
  - A singleton restarts the same range.
  - Either transition clears C, H and attempt-oldest, increments G once, and keeps the completed-segments aggregate, the certificate, the opposite lane and the accepted bounds.
  - There is exactly one release, with the turn passed, and the output is privacy-safe.
- **Discovery caller:**
  - An actual `invalid_cursor` is handled in one post-provider, selection-first transaction, with the restart writer on the same session.
  - The outcome mapping is exact and static.
  - There are no roots, no acceptance, no new reservation, no local retry and no second release.
  - All other provider, structural and acceptance paths are preserved.
- **Exact GREEN evidence:**
  - Isolated PostgreSQL: 281 pass / 1 expected fail = 282. Log `.context/aio-1170-resume/aio1170-invalid-cursor-refusal-green-observed.log`, SHA-256 `b914530f991fdc2a6a03232edcc595ba7b63979fc6e47f15c7969288a153de96`.
  - Unit: 38/38. Log `.context/aio-1170-resume/aio1170-invalid-cursor-refusal-green-unit-observed.log`, SHA-256 `2e387f53b8546aa56bfcf1c5455a9fd1503c8c923151864019fc369d7d695b35`.
  - Typecheck, targeted ESLint and diff check pass.
- **Reviews:**
  - A fresh Opus 5.5 HIGH review returned `GREEN READY FOR REMOTE CHECKPOINT`, with no blocker, HIGH or MEDIUM. Its non-gating LOWs are not claimed covered:
    - malformed stored history relies on the validated CHECK, and is explicitly deferred;
    - the newest-lane, lock-to-update and no-segment variants are deferred;
    - the stale-selection release uses the narrower but safe lease fence;
    - one test regex is sensitive to SQL shape.
  - The exact-dispatch `gpt-6.1-sol` HIGH pre-push task `/root/ac02_sol_finish_coordinator/aio1170_invalid_cursor_green_prepush_review` returned `PASS — SAFE TO PUSH GREEN CHECKPOINT`, with no actionable findings. The exact alias comes from the dispatch metadata.
- **Capacity, latest:** 10% five-hour / 42% seven-day, subscription only, no API key, overage off.
- **Exact next stage, after remote backup and readback:**
  1. The finite remaining accepted runtime evidence: the compatibility writers and the controlled mutants.
  2. Then the required whole-scope reviews and checks.

  MR-06 composition and retesting still wait for PR 743's staging checkpoint.
- **Held gates:** no activation, wiring, PR 743 edit, merge or deploy.

## Current state — 2026-10-24, invalid-cursor RED packet

This section is newer than the one below and supersedes its "exact next stage" bullet.

- **Test-only RED checkpoint `7161f92f554b27b1f5f1a3e996c8a1ac7eea4983`.** It is built on the remotely verified production GREEN head `f556163d09c08b5b32ff8295e853fa13cdcb20ae` through test-only commits `cd996f08`, `c2536ac6` and `7161f92f`. Only `test/datamechanics/slack-history-progress.datamechanics.test.ts` and `test/datamechanics/slack-source-discovery.datamechanics.test.ts` changed; production is unchanged.
- **Coverage:**
  - progressed wide subdivision and singleton restart, preserving privacy, the completed-segments aggregate, the certificate and the opposite lane;
  - the full 12-predicate restart-writer fence, including lease owner alone, plus successor reclaim;
  - actual `invalid_cursor` with a cursor present and with a null cursor;
  - selection-first, same-transaction evidence for both the transition and the refusal;
  - a lease expiring inside that transaction;
  - typed stale-selection and stale-lease refusals;
  - exact no-root, no-local-retry outcomes, with privacy-safe output.
- **Exact RED evidence:** isolated real PostgreSQL produced exactly 14 intended behavioral RED / 267 pass / 1 expected fail = 282, with no setup, compiler or import failure. Durable local log `.context/aio-1170-resume/aio1170-invalid-cursor-refusal-red-final-observed.log`, SHA-256 `0edd6ab449938e812a0b59164b8735d59a7bca9d3b2c623c506d9a16fd90bfe0`. Typecheck, targeted ESLint and diff check pass.
- **Reviews:**
  - Fresh subscription Opus 5.5 HIGH affected review session `95c9db3e-4b46-4b5d-b9c9-99e32d8941b0` returned `RED PACKET READY FOR GREEN IMPLEMENTATION`, with no blocker, HIGH or MEDIUM; it closes both earlier MEDIUMs. It retained these non-gating LOWs, which are tracked without a new broad review loop:
    - the tracking relies on SQL-shape matching of raw SQL only;
    - stale-selection transaction coverage;
    - an incomplete older acceptance-writer deferral note.
  - The mandatory independent reviewer was dispatched as exact `gpt-6.1-sol` HIGH, task `/root/ac02_sol_finish_coordinator/aio1170_invalid_cursor_red_prepush_review`. It independently matched the exact head and evidence SHA, and returned `PASS — SAFE TO PUSH RED CHECKPOINT` with no findings. The runtime exposed the GPT-6 family name; the dispatch metadata confirms the exact alias.
- **Capacity at the review boundary:** 9% five-hour / 42% seven-day, subscription-only, no API key, overage off.
- **Exact next stage, after remote backup and readback:** the same sole writer implements GREEN in the existing restart export and the discovery caller:
  - typed `subdivided` / `restarted` / `refused` outcomes;
  - the full channel fence;
  - the wide split and singleton restart, with the preserved facts;
  - one selection-first authority transaction;
  - static, privacy-safe mappings.

  Exact evidence and reviews follow. Compatibility writers, controlled mutants, whole-scope finals and MR-06 remain later; MR-06 waits for PR 743's staging checkpoint.
- **Held gates:** no activation, wiring, PR 743 edit, merge or deploy.

## Current state — 2026-10-24

- **Exact local checkpoint before this recovery-note commit:** `2658324393c3b35341f57b0f4039300363be5096`, one production commit after the last independently verified remote checkpoint `f6c523ebf540e664565019fb95cbc411931d1a9d`. The branch is `codex/aio-1170-resume-20261005`; the authorized remote branch is `origin/codex/aio-1170-slack-timeline`. Push the recovery-note commit with the packet, then independently read back the exact remote SHA and PR state.
- **AM-F2 ownership is cleared.** The PR 743 owner explicitly assigned PR 714 sole ownership of the bounded Slack cursor-history/segmentation columns, constraints, helpers and matching numbered idempotent migration. PR 743 retains Drive, loader and pool work. The reserved migration is `20261023120000_slack_channel_history_segments.sql`. PR 714 may implement and test on its isolated branch now; final composition/retesting remains held until PR 743 establishes its staging checkpoint. Do not edit the distinct Dropbox PR714 worktree.
- **Accepted contract:** `.context/aio-1170-resume/aio1170-am-f2-deep-history-consolidated-accepted-spec-migration-v1-20261023.md`, SHA-256 `13e5890c7da53445cd851e5f908b13aa5878d30afe504074be1255f96d2d3df3`. The accepted migration amendment, ownership agreement and Linear attachment/readback precede dependent implementation.
- **Migration/schema proof is complete on the isolated branch.** The owned migration and byte-identical schema mirror have passed populated pre-F2 upgrade/replay, catalog/refusal, preservation, current-tag and controlled mutant evidence. Do not widen into PR 743-owned Drive/loader/pool behavior. MR-06 composition and final retesting remain held for PR 743's staging checkpoint.
- **Runtime through GREEN3 is remotely preserved at `9ee7dbd70240eea7044376578b72706baa2eb267`.** Historical and newest claim initialization are implemented; newest eligibility runs before local delay; exact BigInt bounds and fixed static corrupt-bound handling are present. Focused GREEN3 evidence was 58/58 plus unit/type/lint/diff/docs/skills; the related suite's remaining fixture/caller failures became the permanent caller RED packet below.
- **Caller RED packet is reviewed at `8835fc90`.** Only four authorized test files changed: history progress, source discovery, source fences and source bootstrap. It covers direct claim safety/default allowance, five frozen request-bound REDs (including newest `U < A` and historical `0 < S <= U < A`), DH-09 no-request/no-reservation fairness beyond candidate 50, three full-release `page_outside_segment` REDs with deterministic `S-1µs`/`U+1µs` edges and `L < S`, `U < A`, pagination precedence, and the accepted §9.1/§9.2 fixture/inventory corrections.
- **Exact evidence:** isolated PostgreSQL produced 8 intended behavioral RED / 235 GREEN / 1 expected fail = 244 total. The only failures are five request-bound and three page-range assertions; there are no compiler, setup, fixture or CHECK failures. Durable local log SHA-256: `acba46e3f08dff1d785d765a61de323a6ebc80fa767e66bfcb1ed7f6317be5cd`. Source-discovery unit 33/33, typecheck, targeted ESLint, diff, docs and skill checks pass.
- **Reviews:** fresh independent Opus 5.5 HIGH final affected rereview session `7d75a383-8c06-47f5-b2ea-b1e3fb524528` returned `CALLER RED PACKET FIXES READY FOR GREEN IMPLEMENTATION`, no blocker/HIGH/MEDIUM. Mandatory exact-dispatch GPT-6.1 Sol HIGH local reviewer returned `PASS / READY FOR REMOTE CHECKPOINT`, no blocker/HIGH/MEDIUM/LOW, and independently matched the exact head, diff/evidence hashes and behavioral RED accounting.
- **Caller GREEN is complete locally at `14b79fb4dc65589a606c1118a7c62df78b664d54`.** Discovery now requests the claim's frozen S/U, omitting only historical zero S, validates every raw message timestamp against `[S,U]` after the accepted structural precedence, and releases/passes the sent-request turn with the fixed `page_outside_segment` detail before acceptance/root enqueue. Only discovery production and its focused unit test changed; state-writer fences/backstop remain intact.
- **Exact GREEN evidence:** the same isolated PostgreSQL packet is 243 passed + 1 expected fail = 244. Durable local log SHA-256: `bb7fd2cbebb232fe97469568a27369679cf966a9316456a8ce5b1002aa072d83`. Focused unit/guard group 201/201, typecheck, targeted ESLint and diff check pass. Fresh independent Opus 5.5 HIGH session `f497e265-1516-453c-9241-62271c01d3f7` returned `CALLER GREEN READY FOR REMOTE CHECKPOINT`, no blocker/HIGH/MEDIUM. Mandatory exact-dispatch GPT-6.1 Sol HIGH review returned `PASS / READY FOR REMOTE CHECKPOINT`, no blocker/HIGH/MEDIUM/LOW, independently matching the diff and evidence hashes.
- **Acceptance-transaction RED packet is reviewed locally at `6e23a606a0754ee4c2ff36278a461d6b2483abd6`.** Fourteen new cases pin structural precedence, authority before admission, durable and immediate repetition, successor-safe rejected release, wide subdivision, singleton rejection, acceptance before root enqueue, root-insert rollback and stale structural release. The release oracle proves the release statement runs on the acceptance transaction session; assertion output retains only static categories/details, counts and booleans. The accepted §9.1 standalone validator repetition assertion remains preserved.
- **Exact RED evidence:** six-file isolated PostgreSQL produced exactly 11 intended behavioral RED / 246 pass / 1 expected fail = 258, durable log SHA-256 `c612bc0d02f93dfb934bf4433260406c6b5695bc17659daa2008c8e154078cef`. Focused validator/page-request units produced exactly 1 intended RED / 174 pass = 175, log SHA-256 `f7fae430e5f21f4236276180d822275e23c701681df9ee52c3f092c27a51c1cb`. Typecheck, targeted ESLint and diff check pass. Fresh independent Opus 5.5 HIGH affected rereview returned `RED PACKET READY FOR GREEN IMPLEMENTATION`, no blocker/HIGH/MEDIUM. Mandatory exact-dispatch GPT-6.1 Sol HIGH reviewer returned `PASS / READY FOR REMOTE CHECKPOINT`, no blocker/HIGH/MEDIUM/LOW, independently matching HEAD, hashes, failure accounting and focused checks.
- **Acceptance-transaction GREEN is complete locally at `2658324393c3b35341f57b0f4039300363be5096`.** Only `lib/ingest/slack-source-discovery.ts` changed. Structural categories precede repetition; selection authority and the full channel fence precede writer admission; `written` acceptance precedes root enqueue in one transaction; `rejected` releases the same fenced claim in that transaction; `subdivided` gets no second release; `refused` writes nothing; stale rejection release reports refusal without overwriting a successor. Selection mismatch remains first and fenced.
- **Exact GREEN evidence:** the six-file isolated PostgreSQL suite passes 257 + 1 expected fail = 258, durable log SHA-256 `fedf50a0f2fe69696c9b2a4ab14d1dc8b558dafe906e7030618f1e3738dce70d`. Focused unit/guard group passes 201/201, log SHA-256 `5ca7fd760dc8f27e0284d6555bf31631f420fd223dbcace091d225310742d520`. Typecheck, targeted ESLint and diff check pass. Fresh independent Opus 5.5 HIGH returned `GREEN READY FOR REMOTE CHECKPOINT`, no blocker/HIGH/MEDIUM. Mandatory exact-dispatch GPT-6.1 Sol HIGH returned `PASS / READY FOR REMOTE CHECKPOINT`, no blocker/HIGH/MEDIUM/LOW, independently matching HEAD, all supplied hashes and focused checks.
- **Retained nonblocking review notes:** the state-writer order comment predates acceptance-before-enqueue; the typed-outcome switch has no explicit `never` default; caller-level writer-`refused` injection lacks a dedicated case; and durable evidence should continue recording exact check commands. These do not alter the verified GREEN behavior. Invalid-cursor same-range restart/subdivision remains a separate unfinished §5 row and is not claimed complete.
- **Writer/admission:** keep sole subscription-authenticated Opus 5.5 HIGH writer session `b1767100-da84-4808-818f-6b0107480c68`; do not start a second writer. Latest numeric capacity was 5% five-hour / 41% seven-day, API-key variables removed, credits/overage off. Obtain fresh authoritative capacity before the next dispatch and stop at 90% in any applicable window.
- **Exact next stage after GREEN remote/PR readback:** batch the remaining accepted invalid-cursor subdivision/restart and typed-refusal/exhaustiveness evidence into the next coherent RED area, then implement through the same writer. Continue compatibility-writer and controlled-mutant obligations without per-variant review loops. Preserve KR-17's accepted numeric run and exclude it from future PostgreSQL runs absent fresh specific Astra adjudication.
- **Held gates:** no activation/wiring, PR 743 edit/cherry-pick, merge, deploy or production work. PR 714 remains draft against `staging`. Required final whole-scope Opus completion review, fresh Astra HIGH review, blind exact GPT-6.1 Sol HIGH review and final checks occur only after the remaining accepted runtime matrix is complete and MR-06 composition is available.

## Current state — 2026-10-22

- **Exact code checkpoint `8efac4ae`.** This is the AM-F3 production fix. Its red-test base is `8a16bb35` and its staging base is `c5e832c2`. Every bounded AC-02 acceptance row KR-01 to KR-16, and AM-F3 strict raw Slack pagination, are complete on the INACTIVE, unwired contract. The pipeline is not wired or activated.
- **AM-F3** is the accepted F3-only amendment on Linear AIO-1170: 6,144 bytes, SHA-256 `2445601cf50baeb2c42704ef00a7fd7e923511f65c2f4587d7ef7bca8bb6b0d9`, readback comment `eba0a9e6-2d8f-48a0-bef3-efaf00e8ce92`. Its contract is in `slack-timeline-reliability.md` ("Final-review amendments"), and its evidence is in the build record.
- **AM-F2 blocks final code approval.** It is the durable cross-wake cursor-repetition history, and it is PROPOSED and HELD. It has not been reviewed for readiness and is not attached to Linear as accepted. PR 743's live branch owns `postgres/schema.sql`. No migration exists and no migration number is reserved. AM-F2 needs a verified human or existing-owner schema-ownership decision before review, Linear attachment or implementation; there is no cross-chat owner agreement today.
- **KR-17** stays preserved exactly as accepted and excluded from further PostgreSQL runs.
- **The failed whole-scope final-review round satisfied NO final gate.** It ran on exact snapshot `b0067a2cd203d932d5c30eeffd4f30a55e14d3f8`, base `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e`.
  - **Opus:** fresh whole-scope session `bcb7da03-e4e7-4824-9bcf-deff09fdbd6a` returned NOT PASS, with an F1 generation-churn MEDIUM and three LOW. Its source-pipeline partition 2 was sampled, not complete.
  - **Astra:** the fresh high final review returned NOT PASS on the cross-wake A → B → A cycle, now F2.
  - **Sol, CLI route:** the exact GPT-6.1 Sol high launch failed with HTTP 400, as unsupported on the signed-in ChatGPT CLI route. That is a route limitation, not a review verdict.
  - **Sol, collaboration route:** a separate exact-model collaboration review (`gpt-6.1-sol`, high, fresh read-only context; canonical task `aio1170_blind_sol_final_retry`, and no other local identifier exists) reviewed the whole contract. It verified all 168 manifest entries and the exact 73,266-line frozen diff, and returned NOT PASS. It independently confirmed F2 and raised F3, malformed raw pagination metadata. This successful result is kept separate from the failed CLI launch.
  - **Astra owner adjudication, 2026-10-22:**
    - F1 is REJECTED as a MEDIUM, with evidence; a LOW availability follow-up is retained.
    - F2 and F3 are ACCEPTED as MEDIUM.
    - The stale activation and recovery docs are ACCEPTED as a LOW for this packet.
    - The disable/link race is REJECTED, on lock and foreign-key evidence.
    - The unbounded channel lookup is RETAINED as a separate, non-blocking LOW.

    Rejected findings are not reopened without new evidence.
  - **No blind final review has yet reviewed `8efac4ae`** or any later documentation snapshot.
- **Held LOW items:**
  - the stale comment in `lib/dashboard/timeline-cache.ts` is an accepted LOW, held because PR 743 owns that file;
  - the accepted unbounded channel-lookup LOW is a separate, non-blocking follow-up;
  - the F1 availability LOW, retained by the owner adjudication, is a non-blocking follow-up;
  - the AM-F3 implementation review's non-blocking LOW is a possible later follow-up, kept beside AM-F2. A cursor with an unpaired UTF-16 surrogate was not verified and is outside AM-F3: it might be re-encoded, or fail storage. This is not a confirmed defect.
- **Next actions:**
  1. Obtain the AM-F2 schema-ownership decision from a human or the existing owner.
  2. Then either review, attach and implement AM-F2 red-first through the same writer, or record the owner's explicit adjudication.
  3. Only then pin one later stable snapshot for the final whole-scope Opus completion review (including source-pipeline partition 2), a fresh Astra high review, the blind exact GPT-6.1 Sol high review and the final checks.
- **Nothing is authorized here.** PR 714 stays draft against `staging`. No activation, wiring, PR 743 integration, merge or deployment is authorized.

## Exact repository state

- Worktree branch: `codex/aio-1170-resume-20261005`.
- Authorized remote branch: `origin/codex/aio-1170-slack-timeline`.
- PR base: `staging`; the PR must remain draft until the remaining acceptance and final-review gates pass.
- Accepted AC-02 specification: [`docs/design/slack-known-root-requeue-spec.md`](./slack-known-root-requeue-spec.md), SHA-256 `27fcc7197aa6f591cc365d9d1481e105b811ca1cd43d2a96a187f89a4c9ad83a`.
- Build record: [`docs/design/slack-timeline-build-record.md`](./slack-timeline-build-record.md). At commit `ef25449e89cb10cb565713946f93044e9027181a`, its SHA-256 is `774643b4e56dc5beca283a212f698908c8c5cc7d7783b5a94db10909bc8be4fa`.
- Feature base last recorded for this stop: `origin/staging` at `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3`.
- Last remotely verified checkpoint before the KR-12 tests: `ef25449e89cb10cb565713946f93044e9027181a`.
- KR-12 local commits prepared after it: `2c7046b8` and corrected checkpoint `77db22b1332c02f4f224746152c65ade16fef80e`. The final remote SHA is recorded in the PR resume section after the backup push.

The sole implementation, test and build-record writer is subscription-authenticated Claude Opus 5.5 at high effort, persistent session `b1767100-da84-4808-818f-6b0107480c68`. Do not replace it or start a second writer while it is available. The latest authoritative provider events during the focused rereview reported 34% five-hour utilization and 32% seven-day utilization, with overage disabled. Obtain a fresh `/usage` reading before any later dispatch and stop at 90% in any applicable window.

## Completed checkpoint evidence

### M11 and M12

- M11, on the isolated real-PostgreSQL selected case: baseline and restored each passed 1 case with 68 skipped; removing the owner-token predicate produced 0 pass, 1 intended failure and 68 skipped. The source was restored byte-identically.
- M12 used the permanent `test/guards/slack-source-not-wired.test.ts` against transient real-tree wirings. Baseline, unreachable-test control and restored phases passed 8/8. Route, synthetic scheduler-chain, script and root-instrumentation experiments each produced 7 pass and the one intended real-tree failure. All transient paths were removed and `instrumentation.ts` was restored byte-identically.
- M12 is recorded in commit `ef25449e89cb10cb565713946f93044e9027181a`. Fresh independent Opus 5.5 high review session `3607c882-7cb1-420b-8dde-269a05cb4d6d` returned `PASS / READY TO PUSH`, with no blocker, HIGH or MEDIUM.
- The ignored M12 harness and raw run directory remain local under `.context/aio-1170-resume/`. They are not remote backups. The tracked build record carries their sanitized conclusions and hashes; do not claim the raw artifacts are available from GitHub.

### KR-12 reviewed test checkpoint

Only these tests changed after `ef25449e`:

- `test/slack-known-root-requeue.test.ts`
- `test/datamechanics/slack-known-root-requeue.datamechanics.test.ts`

The packet adds exact normal-result restoration coverage for all exported outcomes and reasons, including both `already_pending` paths, plus seven real-PostgreSQL cases for dependency failure, restoration failure, local deadline, `55P03`, `57014`, caught-server-failure transaction tracking, connection reuse and connection-loss discard/replacement.

Fresh independent Opus 5.5 high review session `dc873e66-1b40-4aba-a585-c8e5bbf774ab` initially returned `NOT PASS` with three MEDIUM test-evidence findings: timeout cases could fall back to fixture timeouts, normal-return restoration coverage was overstated, and real transaction-tracker rollback was not isolated. The same sole writer corrected all three in `77db22b1`.

Fresh focused rereview session `7f702d8e-1ab9-4946-ba18-e788cf949c3f` returned `PASS / READY TO RUN`, with no blocker, HIGH or MEDIUM. It verified the exact applied timeout caps and failing SQL, all normal outcome/reason branches with same-session readback, and a genuine caught `55P03` whose refused-looking callback return is overridden by the real transaction failure tracker.

Coordinator-run checks on `77db22b1`:

- `npm run test -- test/slack-known-root-requeue.test.ts -t 'KR-12|known-root due-output conversion contract'`: 32 passed, 200 skipped.
- `npm run test:datamechanics:iso -- test/datamechanics/slack-known-root-requeue.datamechanics.test.ts -t 'KR-12'`: 7 passed, 81 skipped, against a fresh isolated PostgreSQL container. The first sandboxed attempt was denied access to the Docker socket; the normal approved Docker execution passed.
- `npm run typecheck`: passed.
- `npx eslint test/slack-known-root-requeue.test.ts test/datamechanics/slack-known-root-requeue.datamechanics.test.ts`: passed with no output.
- `git diff --check`: passed before the checkpoint commits.

This is test evidence only. The KR-12 result has not yet been appended to the build record, independently reviewed as documentation, or added to the PR body at the time this recovery record was written.

## Exact next actions

1. Read this file, the accepted AC-02 specification, the end of the AC-02 section in the build record, and the final KR-12 rereview artifact if the local ignored context still exists.
2. Verify the local checkout is clean and the remote feature branch equals the final SHA recorded in PR 714. Verify no writer or reviewer from this stop is still active.
3. Obtain fresh authoritative Claude `/usage` evidence. If every applicable window is below 90%, resume only writer session `b1767100-da84-4808-818f-6b0107480c68` for a bounded build-record-only turn. Record the exact KR-12 tests, results, reviews, limitations and checkpoint without claiming all of KR-12 or AC-02 complete beyond the accepted evidence.
4. Give the documentation diff a fresh independent Opus 5.5 high focused review. Run `git diff --check`, `npm run check:docs` and `npm run check:skills`; commit, push to `codex/aio-1170-slack-timeline`, independently read back the remote SHA, and append the checkpoint plus exact attestation to draft PR 714 without replacing its body.
5. Reconcile the remaining AC-02 acceptance matrix. The build record currently keeps KR-02, KR-04, KR-06, KR-07, KR-08 and KR-09 incomplete, and the KR-12 build-record reconciliation is pending. Preserve the accepted KR-17 numeric run; do not rerun or reopen it without fresh specific Astra adjudication.
6. Once the acceptance matrix is genuinely complete, run the required whole-scope fresh Opus review, fresh Astra high review and mandatory blind GPT-6.1 Sol high review against one exact stable snapshot. Reconcile findings through the same writer, rerun only invalidated checks, then run final repository checks and update the draft PR.

Useful focused verification commands:

```sh
npm run test -- test/slack-known-root-requeue.test.ts -t 'KR-12|known-root due-output conversion contract'
npm run test:datamechanics:iso -- test/datamechanics/slack-known-root-requeue.datamechanics.test.ts -t 'KR-12'
npm run typecheck
npx eslint test/slack-known-root-requeue.test.ts test/datamechanics/slack-known-root-requeue.datamechanics.test.ts
git diff --check
npm run check:docs
npm run check:skills
```

## Held gates

Do not add or enable a driver, runner, scheduler, route, action or manual trigger for the known-root primitive. Do not call Slack or another provider, remove or weaken either not-wired guard, change schema, apply repair, perform the identity cutover, edit PR 743-owned shared behavior, integrate PR 743 before its separately authorized landing, merge, deploy, push to `main` or production, force-push, perform live acceptance, or start the soak. Existing authorization covers the draft staging PR and normal task checkpoints only.

AC-02 and AIO-1170 remain incomplete. PR 714 stays open and draft against `staging`.
