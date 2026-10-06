# AIO-1170 / PR 714 recovery handoff

Status recorded at **2026-10-06T05:11:16Z** after the user asked to stop and preserve everything on GitHub. This is a recovery record, not a readiness or completion claim.

## Where to resume

- Pull request: [#714](https://github.com/aiosbrain/aios-team-brain/pull/714), draft, base `staging`, head branch `codex/aio-1170-slack-timeline`.
- Recovery commit before this handoff: `0f3a235dc1b03d509ddc510f8188225a32e3a97a`.
- Last adjudicated `staging` fingerprint: `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e`. Fetch `origin/staging` and reassess before doing more work.
- AC-09 packet baseline/path-gate base: `82f8fabcfddec1913ead628b5e730edb6719f296`.
- Linear issue: [AIO-1170](https://linear.app/je4light/issue/AIO-1170/fix-intermittent-missing-slack-timeline-activity-and-identity), left **In Progress**.
- Accepted AC-09 specification: [`docs/design/slack-aggregate-pagination-spec.md`](./slack-aggregate-pagination-spec.md), 63,619 bytes, SHA-256 `7e93bd200f98ac3f011979b3c4abd52bcad824696c8bdcb3529e34d8c728d9b8`.
- The same complete specification was attached to Linear as `AIO-1170-AC09-aggregate-pagination-7e93bd200f98.md`; verified comment/readback id `6ded857d-de96-4b57-adde-a9e173bb41a5`.
- Historical packet evidence and decisions are in [`docs/design/slack-timeline-build-record.md`](./slack-timeline-build-record.md). The final AC-09 state below supersedes that record's earlier `883aa24d` checkpoint/readiness wording.

## Exact implementation state

AC-09 is an **inactive and unwired** aggregate-pagination packet. The source at `0f3a235d` contains the original implementation plus the accepted corrections from the first Astra and blind Sol final reviews:

1. the wall-clock deadline owns pool checkout, transaction setup, every driver query, commit/rollback and teardown;
2. a client delivered after cancellation executes zero queries and is destroyed;
3. only a server-answered `COMMIT`, or a safe server-answered `ROLLBACK`, permits pool reuse; deadline/abort/unknown state destroys the client;
4. rows and bytes from control statements are metered through the same private query primitive;
5. initial non-Slack input and the published page graph are copied and frozen;
6. malformed non-Slack rows are rejected at the real contract boundary;
7. the provenance tests use the real packet-owned correction/lock reader;
8. a caller-owned cursor-key `Uint8Array` is copied synchronously before any await.

The final-fix checkpoint changed these task paths relative to the previously reviewed candidate:

- `lib/ingest/slack-person-day-page-read.ts`
- `lib/dashboard/slack-timeline-page-contract.ts`
- `test/slack-timeline-page-contract.test.ts`

The complete AC-09 packet also includes:

- `lib/dashboard/slack-timeline-drain.ts`
- `test/datamechanics/slack-person-day-page-read.datamechanics.test.ts`
- `test/slack-timeline-drain.test.ts`
- `test/guards/slack-aggregate-pagination-not-wired.test.ts`
- `test/guards/slack-aggregate-pagination-pr743-paths.ts`

The sole implementation writer was subscription-authenticated `claude-opus-5-5`, high effort, session `b1767100-da84-4808-818f-6b0107480c68`. No Anthropic API key or paid-credit fallback was used. The writer is stopped and no worker owns an uncommitted edit.

## Verification on `0f3a235d`

Coordinator-run results on the exact recovery commit:

- `npm run typecheck`: **PASS**.
- targeted ESLint for the reader, page contract and page-contract test: **PASS**.
- `git diff --check`: **PASS**.
- focused AC-09 unit and no-wiring guards: **317/317 PASS**.
- isolated real-PostgreSQL page-reader suite: **186/186 PASS**.

The focused command was:

```text
SLACK_AGGREGATE_PACKET_BASE=82f8fabcfddec1913ead628b5e730edb6719f296 npm test -- test/slack-timeline-page-contract.test.ts test/slack-timeline-drain.test.ts test/guards/slack-aggregate-pagination-not-wired.test.ts test/guards/slack-source-not-wired.test.ts
```

The PostgreSQL command was:

```text
bash scripts/dm-isolated.sh test/datamechanics/slack-person-day-page-read.datamechanics.test.ts
```

The broad `npm test` was **not rerun** on `0f3a235d` and is not claimed green. Its most recent recorded run passed 8,848 tests and failed three 5-second cases in `test/staging-policy-commissioning.test.ts`; the cause and baseline status of those timeouts were not established.

Five controlled AC-09 mutants had already been killed before the final lifecycle correction: row-limit equality, read-byte equality, page-byte equality, stale statement-timeout refresh and pre-merge Slack-evidence admission. The source was restored byte-identically after each. These do not substitute for final review of `0f3a235d`.

At the stop boundary GitHub checks for PR 714 at exact head `0f3a235d` were green for docs drift, NDA, review attestation, brain-task reference, static checks, secret scan, unit, data mechanics, HTTP integration, Neo4j, staging paired refresh and pytest. Codacy reported `ACTION_REQUIRED`; two status-rollup entries had no name or conclusion. Re-read checks rather than assuming this snapshot remains current.

## Review state: not verified

The first fresh Astra-high and blind GPT-6.1 Sol-high final reviews examined `e72faad0b56a9b58c17276157a1b0b2d595b34a5` and both returned **NOT READY**. Their accepted material findings produced the lifecycle, immutability, validation, provenance-test, cursor-key and control-metering corrections now in `0f3a235d`.

A fresh independent Opus 5.5 high-effort source review of `0f3a235d` began in read-only session `d9ac8ad0-b551-4118-be5e-c00fe45082a2`. It read the complete accepted spec, all three production modules, both guards, the Slack credit/provenance owner, relevant producer shapes, the repository pool wrapper, installed `pg-pool`/`pg` release and socket-close behavior, and real-PostgreSQL lifecycle tests. It had not returned a verdict when the user asked to stop. The process was interrupted at `2026-10-06T05:11:16Z`; its terminal state was `error_during_execution/tool_use`. Therefore:

- the Opus review is **partial and NOT VERIFIED**;
- no finding or readiness conclusion may be inferred from its partial analysis;
- the mandatory fresh Astra-high final review of `0f3a235d` is pending;
- the mandatory fresh independent blind GPT-6.1 Sol-high final review of `0f3a235d` is pending.

Last authoritative Claude subscription reading before stop: current session **9%**, weekly all-model **80%**, Fable **0%**, credits off; session reset displayed 2:20 p.m. Asia/Calcutta and weekly reset Oct 6 at 11:30 p.m. Asia/Calcutta. Recheck actual utilization before any future Claude dispatch.

## Dependency and ownership boundary

PR [#743](https://github.com/aiosbrain/aios-team-brain/pull/743) was read back at the stop boundary as open, draft and blocked, base `staging`, head `e1ba30c4c55cc9aee9c7781394c01546c27830bc`. It is the separate owner of Google Drive and shared ingest/identity lifecycle work. Do not duplicate its implementation on PR 714.

The recorded integration constraints are:

- use one common project/item lock order across ordinary and direct ingest; preserve PR 714's Slack publication, sorted identity, actor, fence, retry and ten-second timeout contracts;
- admit an external Drive row to repair only from authoritative same-team persisted `source_item_mappings(source='gdrive')`, rechecked after the item lock; never infer authority from frontmatter, claims or a non-null connection id;
- preserve generic external-row exclusion outside that explicit Drive case;
- keep identity-authority cleanup atomic with ordered integration locks, generation bumps, fences and lease invalidation;
- compare the observed current identity tuple/revision separately from the requested target, validate it atomically, preserve live-foreign refusal and distinguish add from replace across providers;
- reconcile both branches by behavior after PR 743 lands or during an explicitly authorized integration, then rerun both branches' relevant contract suites and the PR 743 path-disjoint guard.

AC-09 adds no migration. Before future schema work, recheck active worktrees and migration reservations; a clean Git merge is not compatibility evidence.

## Deliberate exclusions and live gates

Do not cross these boundaries without the separate authorization and evidence they require:

- no publisher, route, dashboard, UI, cache or runner wiring;
- do not delete either not-wired guard;
- no repair apply or attended identity cutover;
- no activation, live provider mutation, production write, deployment, merge, push to `main` or force push;
- AC-01 representative live trace, AC-13 live People context, AC-14 24-hour sandbox soak/capacity, saturated-team capacity and secure cursor-key provisioning remain live/activation gates;
- the eventual active adapter must intersect admitted Slack item ids with the real membership oracle.

## Durability incident

During the final lifecycle fix, the Claude stream wrapper exposed only bounded wait calls while the underlying turn ran for about 20.6 minutes. This caused the 10–15 minute local checkpoint and 30-minute remote-backup deadlines to be discovered late. The writer was stopped immediately, the complete three-file diff was preserved in `0f3a235d`, an independent WIP review found no HIGH/blocker for recovery purposes, and the commit was pushed and independently verified on the remote at about `2026-10-06T04:26Z`. No work was lost. Future supervision must use an independent wall-clock/deadline signal rather than trusting the stream wrapper's apparent wait duration.

## Exact next actions

1. Fetch `origin/staging`, PR 714 and PR 743; verify exact SHAs, worktree cleanliness, overlap, migration reservations and ownership before editing.
2. Recheck Claude subscription utilization and authentication. Keep the original Opus session only as the sole writer for accepted fixes; start a **fresh** independent Opus session for the complete Stage 4 source review of exact resumed HEAD.
3. Resolve substantive review findings red-first with the sole writer, checkpoint locally every 10–15 minutes, push/read back at least every 30 minutes, and rerun only affected checks plus the required final set.
4. Run a fresh Astra-high final review and a separate fresh blind GPT-6.1 Sol-high review on the exact stable candidate with complete contract/caller/integration coverage. Prior conclusions must not seed the blind review.
5. Add sanitized whole-scope read-cost measurements and update the AC-09 build record to the exact reviewed head, final findings, checks and limitations. Do not claim broad green without a new successful broad run.
6. Refresh the PR 743 compatibility assessment; if it has landed, compose from fresh `staging` manually by behavior and rerun both suites. If it is still unmerged, keep the shared slice frozen.
7. Run the repository pre-push review/attestation, push the exact candidate, verify `git ls-remote`, update PR 714 without replacing unrelated body content, and read back exact-head CI.
8. Audit the remaining accepted AIO-1170 scope. Continue only genuinely independent accepted work; leave live, activation, wiring, merge and deployment gates pending.

This handoff intentionally stops before further review, implementation, merge or deployment.
