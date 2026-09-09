# AIO-1170 — recoverable build record

State: specification accepted; Opus implementation has not started. This record contains sanitized recovery facts, not credentials, private message content or a production-resolution claim.

## Branch and scope

- Branch: `codex/aio-1170-slack-timeline`.
- Contribution base and intended PR target: `origin/staging`, commit `d1f0c088`; remote base re-fetched and unchanged at final specification preparation.
- Latest committed spec-review checkpoint before this record: `6fcd20ef9cc574f749225ea2eb120620a932f896`.
- Canonical specification: `docs/design/slack-timeline-reliability.md`.
- Accepted specification SHA256: `6d0085bf078e16fce0accf65ee06678b55a27b29f2e2a8bf85775d4f6c8dedba`.
- Owner ticket: AIO-1170, verified In Progress. Overlapping Slack scope was removed from AIO-1166 by the coordinator; other-provider work remains separate.
- No merge, deployment, production repair, live test-message posting or pending-proof draft PR is authorized by this build record.

## Specification review history

| Stage | Snapshot | Outcome and disposition |
|---|---|---|
| Guidance checkpoint | `df333a8a` | Staging destination, carried authorization and durable/remote backup/usage monitoring instructions; bounded local documentation review found no actionable issue. |
| Fable r1 | commit `7ccc7a26`; SHA256 `b7b666e67bcbab6f3fb21c5630778dbc5b1b306e17a2cdfe41e3b465af3ebd73` | BLOCKED. Astra addressed publication/migration gate, unchanged generation churn, continuation UI, capacity gating, identity writer cutover, and supporting medium/low items. Hardcap substitution and generic unfenced social-job reuse were rejected. |
| Fable r2 | commit `2c76dd99`; SHA256 `7691f03bd2d27934b884d0eeb48bdd9e243b35d404c1bd2ae3dbcb9478968ec2` | BLOCKED narrowly. All r1 architecture blockers resolved. Added direct timeline/credit identity-reader cutover and FTS prefix contract; clarified identity cold rebuild, reserved calls, health cadence and migration details. |
| Fable r3 | commit `6fcd20ef9cc574f749225ea2eb120620a932f896`; SHA256 `a8fcf0b60363abf23666965cd595c503ba2902c040a572b7b1a643709be45e93` | READY, no confirmed blockers. Verified H1/H2 resolved and reviewed identity-cache, rate reservation and health changes. |
| Astra final precision | accepted SHA256 above, based on r3 READY | Pinned the r3 nonblocking details: generation storage/hit validation/salvage, unchanged auto-sync, oracle absent-vs-empty semantics, transient metadata status, scheduler health/timer liveness, interactive validation, INSERT/UPDATE refusal and strict error handling. Clarified review cadence. These final wording details were not separately rerun through Fable; do not attribute the final hash directly to its r3 review. |

All three Fable reviews used verified exact Fable 5.1 through subscription authentication; coordinator verified successful process completion and no provider denials. No application code has been reviewed or attested by these specification reviews.

Accepted deterministic check: `aios spec eval docs/design/slack-timeline-reliability.md --no-llm --json` returned `SPEC_READY`, exit0, no findings, with the accepted SHA256 above. This is an offline readiness result, not live proof or permission to publish. The repository was dirty with documentation-only changes when evaluated.

## Baseline verification before implementation

Coordinator reported **74 passing baseline tests** on the staging-based worktree:

- 44 unit tests across Slack normalization, participant parsing, identity resolution and timeline grouping.
- 30 real-Postgres tests across Slack identity, work timeline and timeline cache, using the isolated worktree database.

These are baseline regressions, not tests of the proposed feature. They do not reproduce the user's incident, establish migration safety for new code, or attest reconstructed/modified code. Opus must add outcome-derived failing regressions and run the applicable isolated database/HTTP/UI checks after implementation.

## Accepted implementation invariants

One canonical message metadata ledger; workspace-qualified identities and paths with guarded in-place migration; existing item transaction publishes message state atomically; fair durable polling with per-method reservation; unchanged sync does not churn generations; shared lock-respecting credit; SQL contribution-time/visibility filtering before limits; retrievable same-day overflow; truthful failures and remap-safe cache; existing ACL and copied-staging protections preserved. Schema-only/pure-helper partial slices remain inactive. Identity writers/readers must cut over together; ambiguous legacy provenance blocks publication rather than duplicating or granting credit.

Build with subscription-authenticated Opus only. No fallback builder, API billing or paid-reset bypass. Preserve partial work at local/remote checkpoint intervals and review boundaries; required usage pause policy still applies. Routine recovery commits use the local pre-push review gate; Fable code review is for stable integrated snapshots and substantive reviewed fixes, not every small checkpoint.

## Outstanding acceptance and activation gates

- AC-01: representative reported missing message and visible control, with sanitized stage-by-stage source-to-UI trace. Source examples remain unavailable; no incident resolution claim.
- Installation metadata/capacity: coordinator read proved one enabled Slack integration selecting one channel. App rate category, full retained-root/reply-page demand and actual cycle throughput remain unverified. Conservative-budget fixture implementation is permitted; certified live activation is gated.
- AC-02–13: implementation and corresponding source→DB→identity→query/cache→API/UI tests remain unbuilt. This includes historical namespace repair, lock semantics, overflow, failures and authorization.
- AC-13 live People identity-context proof remains required.
- AC-14: 24-hour controlled soak after initial backfill in an authorized **non-copied** sandbox, including outage, identity correction and measured full cycle. Copied staging ingestion protections must not be bypassed.
- Any reproduced general access-invalidation dependency must be reported for coordinator adjudication; Slack fails closed and AC-11 remains unsatisfied until resolved.
- Required live gates block ready publication. No draft authorization is assumed. Reviewed implementation and passing fixtures alone cannot close this ticket.

The next action is coordinator verification/attachment of the accepted specification, a verified durable checkpoint, then the first inert Opus helper/test packet. Keep this record updated with implementation checkpoints, reviewed hashes, test evidence and remaining gates as work proceeds.

## Implementation checkpoint — pure evidence projection

Opus5 subscription implementation added an unused message-evidence helper,32 new unit cases, and optional bot_id typing. Active ingestion unchanged. Coordinator captured initial missing-helper failure before implementation;20 existing tests passed. After implementation,52 tests across3 suites and npm run typecheck passed at16:03ET2026-09-09. The delegated CLI required Bash approval; coordinator ran checks through normal execution controls. The prior baseline74tests are separate. Routine projection semantics and duplicate-conflict handling remain under Astra adjudication; this checkpoint does not certify integration or live acceptance.

### Packet1 corrections verified

Astra and independent local review identified incomplete author classification and unsafe first-observation conflict selection before integration. Opus replaced conflict selection with a typed whole-batch exception containing sorted IDs only, required explicit known-human flags, and added future-reevaluation and captioned-file exclusion assertions. Coordinator captured8failing regression assertions before fixes, then65passing tests across3suites and typecheck0 at16:14ET. The helper remains unused; later integration/live ACs remain pending.

## Packet2 schema checkpoint — verification pending fixture fix

Checkpoint3ad7035f adds slack_messages and slack_team_state only, plus schema invariants and architecture inventory. Existing items_team_id_id_idx and its deployed migration supply the composite FK; no redundant existing-table migration added. Coordinator fresh isolated database load succeeded;11/12real-Postgres tests passed including populated upgrade/replay. Team-cascade fixture failed because ingest seeded append-only audit rows. Astra approved a test-only minimal raw-SQL fixture, preserving the audit guard and shared lifecycle helpers. Docs drift87tables and typecheck passed. Independent local review found no HIGH/blocker for the inactive backup; remaining fixture verification is not claimed complete. No active writer/reader uses these tables.

### Packet2 fixture correction verified

Opus changed only the team-cascade fixture to minimal raw SQL rows and asserted no audit entries before deletion. Coordinator reran the isolated ledger suite:12/12tests passed at16:38ET, including from-zero/populated upgrade/replay. Audit protection and shared lifecycle helpers remain unchanged. Schema and production code are identical to3ad7035f; prior docs/typecheck checks remain applicable.

## Packet 3 — namespace parser verified

Checkpoint e0cbd9e0 adds an unused pure legacy/scoped path parser and validated scoped builders. Coordinator ran 74 tests across three suites, typecheck and docs drift: all passed at 16:54 ET. Tests were written before the helper; no initial-red run was captured for this new helper. Independent local review found no actionable correctness issue. Its timestamp dependency currently imports node:crypto transitively; extract a browser-compatible timestamp module if a future client component needs this helper. Current inspected data-browser is server-side and the helper has no active callers. Legacy path provenance, migration gates and publication remain pending.
