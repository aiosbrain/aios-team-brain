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

## Packet 4a — pending-thread state verified

Recovery checkpoint 830fd276 adds inactive `slack_sync_threads` storage and session-bound enqueue, claim/reclaim, progress checkpoint and retry release primitives. There is no terminal acknowledgement or publication path. All authority checks use the database clock, full scope, owner and lease generation. Coordinator ran the real-Postgres suite against a freshly initialized worktree-only database: **28/28 tests passed** at 17:14 ET on September 9, 2026, including competing claims, expired/replaced owner refusal, caller rollback and populated schema replay. Type checking and documentation drift checks passed; the tested source matches the recovery commit. The initial captured red was missing-module resolution, not a behavioral regression. Active ingestion and remaining acceptance gates are unchanged. Origin staging was refreshed at 17:15 ET and remains 11eb039b, whose unrelated staging-image publication changes were assessed previously.

Local checkpoint review of 93a7bf93 passed for inactive backup with two medium findings requiring resolution before integration: invalid error-code exceptions currently echo supplied values, and the SQL timestamp syntax cap is narrower than the shared parser for leading-zero seconds. Astra adjudication and Opus corrections are pending. This is not the integrated Fable or final Astra review.

### Packet 4a corrections verified

Opus resolved both medium findings in 3c0f09d2: rejected error categories no longer enter diagnostics, and exact leading-zero root timestamps survive enqueue and schema replay. Coordinator captured two failing timestamp assertions before the schema correction; no initial diagnostic failure was captured because that fix loaded before the test. The corrected source passed **29 database tests**, **95 parser/evidence unit tests**, and type checking at 17:25 ET. A comment-only Opus follow-up fixed a false table match in the documentation scanner; docs checks passed at 17:29 ET, and non-comment SQL was verified byte-identical to the tested version. No scanner bypass or invented inventory entry was added. Active ingestion remains unchanged; all integration and live acceptance gates remain pending.

## Packet 4b — inactive namespace gate

Checkpoint 1ec2f473 adds a default-blocked per-team/raw-channel namespace gate with revision invalidation and a transaction-held readiness read. No application function can produce ready state; provider authorization and the actual provenance migration remain separate dependencies. Coordinator captured an initial missing-module failure, then **24 real-Postgres tests**, type checking and documentation checks passed. A final team-isolation test correction at b7a7fcd9 also passed all 24 tests at 17:52 ET on September 9, 2026. Two additional populated schema replays preserved every column of ready/blocked structural fixtures for two teams in a scratch database within the worktree-only container; the scratch database was removed afterward. These fixtures do not certify real channel provenance.

Astra identified a remaining test gap: the current competing-reader test does not guarantee it observes a database lock wait before the writer commits. A narrow Opus test-only correction is required before integration; no production helper defect was confirmed. The initial inspection-only Opus invocation was stopped without source edits after repeated shell approval requests. Its replacement used file-only tools with coordinator-run verification; no implementation was lost and subscription authentication remained unchanged. Integration and live acceptance gates remain pending.

Local review of 023e54a1 passed for inactive backup with one medium storage-validation finding: joining workspace IDs with commas lets a single comma-containing element satisfy the SQL array constraint. The application codec rejects that value and grants no readiness. Element-safe SQL validation plus a negative database fixture are required before integration, alongside the already recorded deterministic lock-wait regression.

### Packet 4b corrections verified

Opus corrected the workspace-array constraint and strengthened the concurrency test in 7dd6d2c0. Coordinator captured the new array regression failing against the prior isolated database constraint, then **25 real-Postgres tests**, type checking and documentation checks passed at 18:06 ET on September 9, 2026. The concurrency case now observes the writer in the reader's `pg_blocking_pids` before permitting commit. Two valid populated schema replays preserved every field for both team fixtures. A separate replay over the deliberately malformed regression fixture failed with SQLSTATE 23514 on the expected constraint and preserved the complete row; no automatic data repair was performed. The schema edit preceded the regression edits in this follow-up, so tests-first ordering is not claimed. All source matches the verified checkpoint; namespace activation and live acceptance remain pending.

Focused review of a47aae84 passed for inactive backup and confirmed the array and lock-wait fixes. One medium test cleanup issue remains: if the writer fails before its startup signal, the reader can wait on that unresolved signal and mask the cause with a timeout. A narrow test-only correction is queued for the next Opus slice before integration; the passing normal lock-wait result and production helper are unaffected.

## App identity bootstrap specification checkpoint — September 9

Packet4c implementation revealed a feasibility gap before coding: standard bot auth.test can omit app_id. Astra clarified same-token bots.info lookup for the exact authenticated bot, with a shared conservative workspace bootstrap budget. Fable5.1 returned READY for candidate58433486/spec26de4eb6166ba4d56be566c474793e0ee6abb0ed081ab9de4001ae97ab2f8d6f. One parent-directory Glob was denied; the exact authorized handoff listing and requested prompt read then succeeded. Coverage was checked from the transcript; no denied read was treated as evidence.

Astra accepted the three nonblocking precision findings: effective-token cache fingerprint including env fallback, actionable users:read fallback diagnostics, and unbound setup validation deferred until queued binding. These final precision sentences were not separately rerun through Fable. Final canonical spec SHA25619bcdf6edd9ca3bff2b39e69cf7284952dcf4879d84bbbafe67fb2ae1f2e3f14 passed deterministic SPEC_READY and was attached in full to AIO-1170 before further implementation. The complete canonical content and unchanged original request were verified after Linear formatting normalization; AIOS CLI verify-desc confirmed byte-identical readback SHA256aded7c241bf4723becc50eda81c513f5de20040e121a93d0b7c9af6b5f61b678.

No application behavior changed in this checkpoint. Integrated Fable code review, fresh Astra code review and live acceptance gates remain incomplete. PR target remains staging; no main push, merge or deployment. Packet4c next supplies durable method budgets and a one-request adapter, including the previously recorded gate test cleanup.

## Durable Slack requests — initial verified checkpoint

Subscription-authenticated Opus5 implemented the inactive method-budget and single-request adapter plus request tests and the gate-test early-writer-failure cleanup. Local partial checkpoint0208d979 preserves the initial source; c8d78b9e captures the tests and documentation. At c8d78b9e, the coordinator ran123 unit tests across3files and50 isolated real-Postgres tests across2files, all passing, plus typecheck and documentation drift checks. Only the dedicated worktree test container was recreated to load the schema. No initial failing feature test was captured; feature implementation preceded those tests, so this record makes no tests-first claim. The existing writer-failure test cleanup passed as part of the database suites.

Four accepted coordinator/Astra findings remain for the next Opus correction: verified-scope bots.info can bypass the required shared workspace refresh bucket; a valid48-hour Retry-After is shortened by a24-hour clamp; an arbitrary provider error matching the category regex can leak into diagnostics; and HTTP500 with an ok:true body can be reported as success. These new modules still have no active application caller. Existing tests do not discharge those counterexamples. The next correction must add meaningful regressions and preserve pending request allowance during schema replay.

No integrated Fable code review or fresh final Astra review has run; no acceptance criterion or live incident resolution is certified. Canonical accepted spec19bc remains fully attached in AIO-1170. Remaining work includes integrated discovery, publication, identity-context attribution, timeline/cache/UI, historical repair and required live gates. All pushes remain feature-branch backups for a staging-targeted PR.

## Request correction recovery checkpoint

Opus corrected all four initial request findings at b6494d56. Coordinator verification passed133 unit tests and57 real-Postgres tests, including populated bucket consolidation and repeated schema replay, plus typecheck. The documentation guard initially failed because a SQL comment was parsed as a table name. Actual failing baselines were captured first: unknown-code/HTTP unit cases, verified bots.info and48-hour database cases, and old-schema replay leaving obsolete rows. Missing new helper exports in some early unit failures are not represented as behavioral proof.

Astra found one remaining gap in the exceptional unrepresentable Retry-After path: an immediate blocked result left the shared bucket available after60seconds. Opus is adding a durable categorical block, preserving it through consolidation and returning blocked with zero HTTP for all later callers. Three new unit regressions failed against the prior code before these edits. The SQL comment has now been corrected and the docs guard passes. Current marker/schema/transport changes are a partial, unverified recovery snapshot; the Opus worker was briefly paused to make this remote backup stable and will resume from the same session. Previous passing results do not attest these newer changes.

The last verified remote checkpoint before this backup was47deda72. Newer local changes were preserved while the docs guard prevented backup; no guard was bypassed. All code remains inactive, with no application runner or publication wired to the new helpers. Integrated Fable/final Astra review and live acceptance gates remain outstanding.

## Request dependency verified after durable-block completion

The stable partial checkpoint77046abd was independently reviewed and pushed, then the same paused Opus process resumed. Final source33d48386 passed135 unit tests across3files and64 isolated real-Postgres tests across2files, plus typecheck and documentation checks. The database suite covers the real cross-caller block after the original deadline, propagation of marker-write failure, an upgrade from a table without blocked_reason, and preservation of any source/destination block through repeated populated consolidation. The three unit regressions had failed against the previous implementation before these edits.

The previously recorded initial request findings and the shared-block gap are corrected and tested. The single-request adapter is the only library importer of the budget module; neither has an active runner, admin or UI caller. This completes the inactive request dependency, not source discovery or incident resolution. The next slice connects real integration/config/effective-token binding, reserved provider requests, channel leases and atomic root enqueue/frontier progress through one internal discovery entrypoint. Publication, identity-context integration, timeline/cache/UI and live gates remain outstanding. Integrated Fable and fresh Astra code reviews remain required before a ready PR.

## Discovery schema and contract backup

Local schema checkpoint81efca81 loaded successfully in the dedicated isolated database and preserved all38 request-budget database regressions. Checkpoints b919151f and63548a71 add real encrypted synthetic integration fixtures and bootstrap, history/recovery and unit contracts before the discovery module exists. Baseline discovery suites failed collection on the missing module, with zero behavioral assertions executed; the inactive-wiring guard passed. These results are not a completed discovery implementation or an assertion-level red baseline.

The sole subscription Opus5 worker was briefly frozen for this stable review and backup, to resume in the same session afterward. Latest fresh Claude usage at19:54ET was61% session,72% weekly and64% Fable, credits off; no quota pause applies. Recovery remains from the same durable worktree and accepted19bc spec. A read-only integration plan pins existing shared identity/People context and timeline query/cache/pagination seams for later work. No legacy runner activation, ready PR, main push, merge or deployment. Required integrated reviews and live gates remain pending.
