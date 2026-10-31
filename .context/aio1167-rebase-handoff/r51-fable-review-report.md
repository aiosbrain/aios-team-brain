# AIO-1167 R51 — Fable 5.1 final-delta and coverage review

**Verdict: no actionable findings in the reviewed scope at High or Medium severity.** Two Low items are listed for Astra's disposition. Neither blocks the blind final reviews. All six R50 corrections accepted by Astra are closed in the frozen code. The R47 Admin refresh and grant-policy TypeScript and the root-coverage chain were inspected on the frozen versions and no defect was found. R49 F6 remains deferred and is not claimed solved anywhere in the patch or mapping.

Snapshot identity. I could not compute SHA-256 values without a shell. I compared every added and context hunk of the frozen patch against the current worktree files for all 18 production and schema paths and for every test file I opened. No divergence was found. Line numbers below are current worktree lines.

## Actionable findings

### L1 — Low, diagnostics: a terminal authority refusal during the orderly-return flush escapes the coordinator

- Where: `ingestion/aios_ingest/gdrive_sync.py:403` through `:425`, called at `:1377`, `:1426`, `:1527`, `:1814`.
- Scenario: the standing-hold early return after a fresh acquisition. A pause, scope edit or lease replacement commits between `acquire` and the repair checkpoint. The brain answers `stale_execution` or `connection_unavailable`.
- Expected: the run reports the hold category plus the authority code, as the stream routine does at `:2632` through `:2641` when it converts a terminal error into a summary.
- Actual: with `cause is None` the flush re-raises. The exception leaves `run_gdrive_stream`. The scheduler reports a generic failure with backlog unknown at `ingestion/aios_ingest/scheduler.py:157` through `:173`, and a manual run reports the same at `:315` through `:322`. The `rate_limited` partial outcome is lost from the report.
- Impact: diagnostics only. The hold is already in local SQLite and the lease is released in `finally`. The writer recorded this as unresolved item 4 in the acceptance map. The drain-phase hold handler at `:1672` through `:1674` has the same re-raise, so there is precedent, but the stream path is the better model.
- Regression: at the standing-hold return, make the flush checkpoint answer `BrainError(409, "stale_execution")`. Assert the summary carries `rate_limited` and `stale_execution`, not `coordinator_error`.

### L2 — Low, provenance: brain-client local fallback delays are stored as external minima

- Where: `ingestion/aios_ingest/brain_client.py:350` through `:358` and `:609` through `:619`. Consumers at `ingestion/aios_ingest/gdrive_sync.py:3494` through `:3512` and `:3182` through `:3186`.
- Scenario: the brain answers a push or checkpoint with 5xx and no Retry-After. The client computes its own exponential delay and puts it in `not_before` of the deferral. The sink-failure path then passes it as `retry_after` with the default `external=True`, and the post-push path records it as `minimum`.
- Expected per the R50 F6 rule: only a wait named by the remote party is an external minimum. A locally computed fallback is backoff that rearm may drop.
- Actual: up to about 30 seconds of sidecar-computed wait survives an explicit rearm as if brain-named.
- Impact: very small. Astra's F6 text retained "brain-named checkpoint/deferral minima", and the client does not mark which deferrals carry a server delay, so this is a boundary note rather than a deviation from the accepted scope.
- Regression: a push answered 503 without Retry-After, then rearm. Assert `minimum_not_before` is NULL and the row is eligible at once. A push answered with a Retry-After header must keep its minimum.

## Rollout and environment gates, unchanged

- R49 F6 repeated deterministic checkpoint refusal stays deferred behind the pre-unattended-rollout gate. `_push_doc` still replays on repeated refusal.
- H2, M-b, M-c, M-d, live Google certification and soak, opt-in and runner proof, canary and rollback remain open.
- Full data-mechanics still has the two environment-gated failures the coordinator recorded. The `json_each` dependency was verified by the coordinator on the declared runtime floor only.
- The Admin connection test and Picker verification do not write an audit row for their token refresh. The broker does. The spec requires issuance audit for the broker, not for Admin previews, so this is a note, not a gap.

## Speculative risks

- The `deferred_root_document_held` count is set once per page and summed across pages and streams, so it can read above one in a multi-page drain. Diagnostic only.
- A deferred folder root whose probe answers not-found authorizes the rescan, which then records the root unavailable from one more 404 and publishes without the retained nested membership. This is the accepted R48 D1 verified-loss path and I confirmed it, but the loss of nested claims rests on two provider 404 answers in one run.

## R50 accepted findings: closure evidence

| Accepted correction | Owner traced | Closure |
|---|---|---|
| Deferred nested membership cannot cause inferred removal | `gdrive_sync.py:2513` hold on `deferred_here ∩ membership_roots`; `deferred_here` from `state.deferred_roots` at `:2338`; `settle_root` refusal for deferred roots `state.py:1103` through `:1121`; retained membership only, no traversal, `gdrive_sync.py:2873` through `:2887` and `state.py:2029` through `:2058` | Closed. Explicit tombstones still remove through `absence_withheld`, as Astra kept. Fresh state retains nothing, so nothing is invented. |
| Each binding Retry-After journaled before later short-circuits | `observe` callback at `gdrive_sync.py:1008` and `:832`; coordinator journal `:1455` through `:1459`; flush on BrainError `:1484`, on quota or local stop `:1490`, on no-streams `:1527`, on start token `:1561` and `:1567` | Closed. Journal write is a SQLite commit before the next read. |
| Unpublished hold and resource compared separately and recovered after reacquisition without crossing the latch | `_restriction_outstanding` `:297` through `:308`; latch short-circuit `:387` through `:389`; standing-hold repair `:1367` through `:1378`; drain handler keeps checkpoint code `:1677`; end-of-run flush `:1814`; dedupe across streams `:3718` through `:3721` | Closed. Acquisition clears the latch at `brain_client.py:439`. |
| One bounded root-local probe per root per run before whole-stream rescan | `_deferred_root_admissible` `:630` through `:689`; coordinator set `:1622` and `:1647`; call `:2089`; probe never settles the root | Closed. Quota raises the account hold; local deadline ends probing; a named minimum forbids later probes. |
| Local fallback is not a provider-owned minimum | `_fail_work(external=)` `:112` through `:145`; drain `:3313` through `:3316`; `_restrict_resource` requires `provider_deadline` `:348` | Closed for provider deferrals. See L2 for the brain-client analogue. |
| Dispatch and run deadlines distinct | drain `:3295`; start-token seam `:707` through `:712`; coordinator capture `:1567` via `_open_account_hold` `:451` | Closed. |
| Run now rearms exhausted work only | `state.py:1705` through `:1722`; coordinator `:1634` through `:1636` | Preserved; negative control present. |

Negative controls and isolation verified by reading: another account's evidence is carried in `retained_restrictions` and never adopted at `connector_state.py:750` through `:794` and `gdrive_sync.py:321` through `:339`; a shorter later minimum never shortens at `state.py:2620` through `:2714`; stream and root isolation on non-quota answers at `:1001` through `:1012` and `:1563` through `:1577`; verified disappearance and restoration through `record_root_unavailable` and `settle_root(enumerated=True)` at `:2765` through `:2768` and `:2843` through `:2845`.

## Admin refresh and grant-policy ledger

| Interaction | Evidence | Result |
|---|---|---|
| Authority capture binds generation and credential revision | `lib/integrations/gdrive-authority.ts:335` through `:384` | Verified. Ceiling computed before any provider call at `:364`; null ceiling refuses with reconnect. |
| Revalidation on both sides of the network call | `:406` and `:421`; per-target `authorizeGdriveAdminTestCall` in `app/t/[team]/admin/integrations/actions.ts:84`, `:1195`, `:1267` | Verified. Pause, role loss and credential change refuse before any Drive read. |
| Same grant ceiling in Admin and execution | `storedGrantCeiling` at `:364` and `:1043`; `refreshedGrantScopes` shared at `:995` through `:998`; `evaluateGdriveGrant` at `:432` and `:1085` | Verified identical rule and fallback order. |
| Omitted-scope fallback | `:995` through `:998`; `scopeSet` is credential-owned under `mergeLockedGdriveCredentialFields` at `lib/integrations/gdrive-credential-fields.ts:67` through `:82` | Verified. An Admin save cannot widen the fallback. |
| Broadened or downgraded grants | `lib/integrations/gdrive-grant-policy.ts:78` through `:102` | Verified. Broader refuses and is never relabelled; insufficient refuses. |
| Manual-root and Picker verification | `actions.ts:76` through `:103`, `:229` through `:259`, `:1242` through `:1292`; publication re-locks at `gdrive-authority.ts:454` through `:491` | Verified. Roots proved against the locked snapshot; publication refuses on generation or credential movement. |
| Token confidentiality | `actions.ts:1229` through `:1233` returns only `GdriveAuthorityError.message` or a fixed string; Picker and manual paths return `Error.message` but no path places the token in an error | Verified. No token reaches the browser in any traced path. |
| OAuth publication and tombstones | `lib/integrations/gdrive-oauth.ts:210` through `:228`; `lib/identity/member-identities.ts:148` through `:161` | Verified. Existing-owner conflict checked before the tombstone return; conflict rolls back the whole transaction; callback returns 409 at `app/api/auth/gdrive/callback/route.ts:166`. |
| Email canonicalization | `member-identities.ts:82` through `:87`, `:162` through `:175`; `app/t/[team]/admin/members/actions.ts:203` through `:205` | Verified. Opaque ids keep case; differently spelled legacy row refused; unlink does not canonicalize by design. |
| Regression exercise | `gdrive-admin-grant-policy` covers all three Admin paths, omitted scope, legacy ceiling, no-ceiling, pause mid-refresh; `gdrive-admin-credential-race` and `gdrive-admin-test` cover credential change and role loss; `gdrive-identity-tombstone-email` covers tombstones, inconsistent tombstone, race, canonical email | The tests exercise the boundaries they name. Security properties were verified by tracing code, not inferred from tests. |

## Root evidence to claim retirement ledger

| Step | Evidence | Result |
|---|---|---|
| Root evidence construction | `connector_state.py:116` through `:131`; carried on every checkpoint at `gdrive_sync.py:3642` through `:3645` | Verified. Deferred roots travel as `uncertain` with the deferred detail. |
| Acknowledgment and adoption | `_adopt_remote_root_evidence` `:1029` through `:1040`; `restore_root_obligation` `state.py:1014` through `:1038` | Verified. Local evidence stands; brain evidence fills gaps. |
| Sidecar gate | `_root_coverage_complete` `:1043` through `:1060`; `_submit_complete_snapshot` `:1073` through `:1097` publishes current roots first | Verified. Any unsettled root blocks. |
| Locked brain gate | `lib/integrations/gdrive-root-coverage.ts:55` through `:91`; `withGdriveExecutionCommit` at `gdrive-authority.ts:862` through `:886`; route flag at `app/api/v1/items/source-reconcile/route.ts:128` | Verified. Evaluated on the locked row; `uncertain` refuses. |
| Claim retirement | `lib/ingest/source-reconcile.ts:171` through `:238`; `retireGdriveItemClaim` at `lib/projects/context/gdrive-claims.ts:161` through `:209` | Verified. Scoped to the connection; survivors keep content. Real-Postgres overlap test matches. |
| Direct per-document removal | `absence_withheld` `:2345` through `:2407`; F1 hold `:2513`; `_cross_stream_removal` `:3369` through `:3466` requires positive provider loss when the roster is unknown | Verified. The complete-snapshot guard is not relied on for this path; the hold, unverified-root withholding and positive-loss verification protect it separately. |
| Overlapping and cross-connection claims | retained `root_ids` provenance at `state.py:2001` through `:2027`; `test_deferred_root_scope` overlap case; `gdrive-complete-snapshot-overlap` | Verified. |

## Coverage ledger for the 40 manifest paths

| Path | Coverage | Evidence |
|---|---|---|
| app/t/[team]/admin/integrations/actions.ts | PARTIAL | Lines 56 to 296 and 1150 to 1305 read; every Drive function and the diff hunks; non-Drive actions not read. |
| app/t/[team]/admin/members/actions.ts | PARTIAL | Lines 170 to 250 read with the diff hunk; rest unchanged and unread. |
| components/admin/identity-conflicts.tsx | FULL | Whole file read; matches diff. |
| docs/ARCHITECTURE.md | PARTIAL | All diff hunks read and checked against code; the current file was not re-read in full. |
| ingestion/aios_ingest/brain_client.py | PARTIAL | Lines 280 to 620 read plus `_retry_after` and `_iso_after`; diff hunks; remainder unread. |
| ingestion/aios_ingest/connector_state.py | FULL | Lines 1 to 170 read; lines 170 to 352 via complete diff hunk. |
| ingestion/aios_ingest/gdrive_sync.py | FULL | Lines 1 to 3821 read in full. |
| ingestion/aios_ingest/sources/gdrive.py | PARTIAL | Lines 660 to 769 read; diff hunks for `ProviderDeferred`, `parse_retry_after`, `_retry_after`; remainder unread. |
| ingestion/aios_ingest/state.py | PARTIAL | Lines 940 to 1200, 1540 to 1600, 1755 to 1815, 1880 to 2560 read; all diff hunks; other ranges unread. |
| ingestion/tests/test_drain_recovery.py | PARTIAL | Diff hunk and lines 195 to 250. |
| ingestion/tests/test_gdrive_poll_reporting.py | PARTIAL | Diff hunk and lines 290 to 355. |
| ingestion/tests/test_gdrive_upgrade.py | PARTIAL | Diff hunks and the `_DriveWorld` harness, lines 5340 to 5760. |
| lib/identity/member-identities.ts | FULL | Whole file read. |
| lib/integrations/gdrive-authority.ts | FULL | Whole file read, lines 1 to 1126. |
| lib/integrations/gdrive-oauth.ts | FULL | Whole file read. |
| postgres/schema.sql | PARTIAL | Lines 2715 to 2794 read and compared with the migration; rest unchanged. |
| test/datamechanics/gdrive-admin-credential-race.datamechanics.test.ts | PARTIAL | Diff hunk only. |
| test/datamechanics/gdrive-admin-test.datamechanics.test.ts | PARTIAL | Diff hunks only; scenarios understood from them. |
| test/datamechanics/gdrive-authority.datamechanics.test.ts | PARTIAL | Diff hunks only, including the R50 lifetime and migration-replay tests. |
| test/datamechanics/gdrive-oauth-lock-order.datamechanics.test.ts | PARTIAL | Diff hunk only. |
| test/datamechanics/identity-discovery-conflicts.datamechanics.test.ts | PARTIAL | Diff hunks only. |
| test/identity-conflicts-view.test.ts | PARTIAL | Diff hunks only. |
| ingestion/tests/test_account_hold_before_streams.py | FULL | Whole file read. |
| ingestion/tests/test_bound_root_loss.py | FULL | Whole file read. |
| ingestion/tests/test_checkpoint_acknowledgment.py | FULL | Whole file read. |
| ingestion/tests/test_checkpoint_uncertainty_latch.py | FULL | Whole file read. |
| ingestion/tests/test_deferred_root_scope.py | FULL | Whole file read; scenarios traced through code. |
| ingestion/tests/test_document_restrictions.py | FULL | Whole file read. |
| ingestion/tests/test_exhaustion_is_not_completion.py | FULL | Whole file read. |
| ingestion/tests/test_pre_stream_scope.py | FULL | Whole file read. |
| ingestion/tests/test_restricted_root_recovery.py | FULL | Whole file read. |
| ingestion/tests/test_restriction_lifetime.py | FULL | Whole file read. |
| ingestion/tests/test_restriction_publication_recovery.py | FULL | Whole file read; scenarios traced through code. |
| ingestion/tests/test_retry_after_holds.py | FULL | Whole file read. |
| ingestion/tests/test_retry_after_parsing.py | FULL | Whole file read. |
| ingestion/tests/test_root_evidence_r49.py | FULL | Whole file read. |
| postgres/migrations/20261031140000_gdrive_restriction_generation_lifetime.sql | FULL | Whole file read; body matches the schema mirror. |
| test/datamechanics/gdrive-admin-grant-policy.datamechanics.test.ts | FULL | Whole file read. |
| test/datamechanics/gdrive-complete-snapshot-overlap.datamechanics.test.ts | FULL | Whole file read. |
| test/datamechanics/gdrive-identity-tombstone-email.datamechanics.test.ts | FULL | Whole file read. |

Unchanged owners read beyond the manifest: `lib/integrations/gdrive-root-coverage.ts`, `lib/integrations/gdrive-grant-policy.ts`, `lib/integrations/gdrive-credential-fields.ts`, `lib/ingest/source-reconcile.ts`, `app/api/v1/integrations/gdrive/execution/route.ts`, `app/api/auth/gdrive/callback/route.ts`, the reconcile route gate line, `retireGdriveItemClaim`, and the scheduler's exception handling.

## Limits

I ran nothing. Every PASS in the acceptance map remains coordinator evidence. The PARTIAL rows cover regions the patch does not touch or the bulk of large test files whose changed hunks I did read, so no material path or interaction remains uninspected and no HOLD is needed. This review covers the frozen 40-path delta on base `5ecd2989` and makes no whole-branch, merge or release-readiness claim.
