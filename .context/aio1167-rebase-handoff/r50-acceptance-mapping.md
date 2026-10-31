# AIO-1167 R50 — acceptance mapping (Astra-adjudicated Fable R49 corrections)

Writer: Claude Opus 5.5 HIGH, session `628402d5-a1c6-42b7-b736-e84358c1a749` (same-writer continuation).
Frozen inputs: R49 base `5ecd2989e21fded915b41b508477bb267aaec06d`; Fable review
`r49-fable-review-report.md`; Astra adjudication `astra-r49-adjudication.md`.

**No test, migration replay, type check or lint was run by the writer** (prompt: coordinator owns
commands). Coordinator results are recorded below for the exact frozen R50 source delta. This document makes no
publication-readiness claim.

Pytest ids for stacked parametrize are written `[<nearest-decorator id>-<outer id>]`.

## F1 — provider minimums outlive the execution generation (accepted)

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Brain keeps restriction evidence across scope/credential transitions; streams/roots/watches/cursors reset; stale worker refused | `postgres/migrations/20261031140000_gdrive_restriction_generation_lifetime.sql` (`gdrive_retained_restriction_progress`, `sync_gdrive_connection_authority`), mirrored in `postgres/schema.sql` | `gdrive-authority.datamechanics.test.ts` › "R50: a scope or credential transition keeps provider-minimum evidence, resets everything else, and still refuses the stale worker" | PASS — coordinator verification below |
| Migration replays; helper keeps only `account_hold`/`document_restrictions`/`retained_restrictions` | same | `gdrive-authority.datamechanics.test.ts` › "R50: the restriction-lifetime migration replays safely and its helper keeps only the three sections" | PASS — coordinator verification below |
| Local lifetime keyed by connection + verified account + provider id across generations; monotonic; unrepresentable sticky | `state.py` `connection_hold`, `hold_connection`, `restrict_document`, `document_restrictions`, `restriction_credentials` | `test_restriction_lifetime.py::test_a_generation_change_cannot_waive_a_document_minimum[add-root-long]`, `[add-root-unrepresentable]`, `[empty-then-reselect-long]`, `[empty-then-reselect-unrepresentable]`, `[same-account-reconnect-long]`, `[same-account-reconnect-unrepresentable]` | PASS — coordinator verification below |
| Deselected restriction retained, not backlog; reselection cannot read early | `state.py` (aggregation), `gdrive_sync._restriction_sections` | `test_restriction_lifetime.py::test_a_deselected_document_keeps_its_minimum_and_reselection_cannot_read_early` | PASS — coordinator verification below |
| Account isolation: another account neither inherits nor erases | `connector_state.parse_restriction_evidence`/`restriction_sections` (`retained_restrictions`), `gdrive_sync._adopt_remote_restriction_evidence` (own account only) | `test_restriction_lifetime.py::test_another_account_neither_inherits_nor_erases_the_original_accounts_minimum`; `test_account_hold_before_streams.py::test_a_hold_for_another_account_does_not_hold_this_one` | PASS — coordinator verification below |
| Account hold survives scope edit / same-account reconnect / earlier generation | same + `state.connection_hold` | `test_restriction_lifetime.py::test_an_account_hold_survives_a_scope_edit_and_a_same_account_reconnect[scope-edit]`, `[same-account-reconnect]`; `test_account_hold_before_streams.py::test_a_hold_observed_in_an_earlier_generation_still_holds_this_account` | PASS — coordinator verification below |
| Admission before every direct read incl. initial binding and relocation | `gdrive_sync` `restricted_now()` → `_bind_selected_roots(restricted=)`, `_reobserve_stalled_relocations(restricted=)`, start-token loops, baseline root reads, identity read | covered by F3 rows (relocation, start token, identity) and F4 rows (baseline/rescan) | PASS — coordinator verification below |

## F2 — explicit rearm resets attempts AND local backoff (accepted)

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Rearm drops only local exponential backoff; external (provider/checkpoint-deferral) minimum kept; untracked legacy combined deadline not blindly nulled | `state.py` `pending_work.minimum_not_before`, `deadline_tracked`; `fail_work(minimum=)`; `rearm_exhausted`; `gdrive_sync._fail_work` / checkpoint-deferral `fail_work(minimum=exc.not_before)` | `test_document_restrictions.py::test_rearm_drops_only_the_local_backoff_and_keeps_external_and_unknown_minimums` | PASS — coordinator verification below |
| Real nonzero backoff: explicit rearm retries exhausted unrestricted work at once; ordinary polling stays bounded (replaces the year-2099 synthetic test) | same | `test_document_restrictions.py::test_explicit_rearm_retries_exhausted_unrestricted_work_at_once_while_polling_stays_bounded` | PASS — coordinator verification below |

## F3 — pre-stream answers scoped to their operation (accepted)

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| 429 / quota-403 on initial binding → account hold, no further account call | `gdrive_sync._open_account_hold` (holds only `rate_limited`) | `test_pre_stream_scope.py::test_a_quota_answer_on_initial_root_binding_is_the_accounts_hold[429]`, `[403-rate-limit]` | PASS — coordinator verification below |
| Root metadata 503 + long Retry-After → that root only; siblings run; no early retry incl. fresh state; no inferred absence | `_bind_selected_roots(deferred=)`, coordinator `deferred_roots` loop, `_restrict_resource` | `test_pre_stream_scope.py::test_a_root_503_with_a_long_retry_after_defers_that_root_alone` | PASS — coordinator verification below |
| Start-token 503 / timeout → that stream only; named minimum only for 503 | coordinator capture loop; `_stream_start_deferred`, `_start_token_restricted` (`start-token:<drive>`) | `test_pre_stream_scope.py::test_a_start_token_deferral_isolates_that_stream[503-long]`, `[timeout]` | PASS — coordinator verification below |
| Relocation re-read 503 → that root only | `_reobserve_stalled_relocations(deferred=)` | `test_pre_stream_scope.py::test_a_relocation_reread_answered_503_defers_that_root_alone` | PASS — coordinator verification below |
| Identity verification 503 → prerequisite deferred, no account hold | coordinator identity branch (`prerequisite:service-account-identity`) | `test_pre_stream_scope.py::test_a_service_account_identity_503_defers_the_prerequisite_without_an_account_hold` | PASS — coordinator verification below |

## F4 — restricted-root recovery liveness (accepted)

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| After 410 rescan: restricted file root deferred (durable obligation), retained proven membership, stream publishes, same/cross-drive independent edits flow, run partial, no inferred absence | `_enumerate_baseline` `defer_root`; `state.mark_root_deferred`, `retained_root_membership`, `ROOT_DEFERRED_PREFIX` | `test_restricted_root_recovery.py::test_after_a_410_rescan_a_restricted_file_root_is_deferred_and_independent_edits_flow` | PASS — coordinator verification below |
| Fresh-state recovery invents no membership | `retained_root_membership` (active published snapshot only) | `test_restricted_root_recovery.py::test_after_fresh_state_recovery_a_restricted_file_root_invents_no_membership` | PASS — coordinator verification below |
| Expiry → listed again (restoration), connection completes | `_deferred_root_admissible` (rescan trigger), `settle_root(enumerated=True)` | `test_restricted_root_recovery.py::test_once_the_minimum_passes_the_deferred_root_is_listed_again_and_the_connection_completes` | PASS — coordinator verification below |
| Removal while restricted applied only through the verified path; stale upsert never pushes removed content | `settle_root(enumerated=False)` refusal; D1 path on re-read | `test_restricted_root_recovery.py::test_a_removal_while_restricted_is_applied_only_through_the_verified_path` | PASS — coordinator verification below |

## F5 — inconsistent tombstone identity (accepted)

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Different existing owner detected before tombstone early return; automatic publication rolls back everything; ordinary tombstones still publish without relinking | `lib/identity/member-identities.ts` (`linkMemberIdentity`, `respectTombstone` branch); `lib/integrations/gdrive-oauth.ts` raises `GoogleIdentityConflictError` on `conflict` | `gdrive-identity-tombstone-email.datamechanics.test.ts` › "R50 F5: an inconsistent tombstone hiding a different owner is the visible conflict, and nothing is published" (ordinary-tombstone case: existing tests in the same file, unchanged) | PASS — coordinator verification below |

## F6 — DEFERRED by Astra; not implemented

No UI/API, generic outage detector, queue redesign, operator override or competing restriction owner was added.

## F7 — diagnostics (accepted)

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Root-unavailable counted once per run across phases/streams | `_note_root_unavailable`, `_merge_summary` | `test_restricted_root_recovery.py::test_a_root_verified_unavailable_twice_in_one_run_counts_once`; `test_restricted_root_recovery.py::test_root_unavailable_counts_deduplicate_across_phases_and_streams` | PASS — coordinator verification below |
| `document_restriction_unpublished` when newly learned/extended evidence not acknowledged | `_restriction_unpublished`, `_publish_restriction_evidence`, coordinator return | `test_restricted_root_recovery.py::test_a_newly_learned_restriction_no_checkpoint_carried_is_reported_unpublished` | PASS — coordinator verification below |
| BrainClient uncertainty latch preserved; no early republish | `brain_client` latch (unchanged); `_checkpoint_progress` uses `apply_restriction_sections` | `test_checkpoint_acknowledgment.py::test_a_new_restriction_under_a_lost_acknowledgment_is_kept_reported_and_never_republished_early` | PASS — coordinator verification below |

## Known behavior boundaries for independent review

1. The empty-selection path runs before the credential broker, so its own verified account is not yet
   known there; evidence is carried forward (in `retained_restrictions` if attributed to another key)
   rather than adopted on that path.
2. Removals under a restricted resource are deferred until the root is enumerated again (by design of
   F4; no inferred absence).
3. A non-provider-deadline root deferral (e.g. a timeout) records no minimum, so
   `_deferred_root_admissible` may start a controlled rescan each run until the root is read — bounded
   by the page budget, but repeated.
4. Losing both local SQLite and unpublished evidence remains the documented durability limitation.
5. The migration uses `jsonb` functions only. The repository declares no dedicated sidecar Docker image; the package supports Python `>=3.11`. Coordinator verified `json_each` on the supported Python 3.11 runtime baseline (details below).


## Coordinator verification — frozen R50 source delta

The reviewed source delta remains frozen at base `5ecd2989e21fded915b41b508477bb267aaec06d`; its complete patch SHA-256 is `53c3d7068b1977e35fae8280475b05a24276dbc557fdd60b92fe71a65aaa37fd` (37 source paths; `.context/` excluded). No source file changed during these checks. The patch manifest SHA-256 is `aa37aba6fadb569f5ce7d6af38b740d73c4f375302dfe4ee81941f29a3271587`.

- R50-focused Python regressions: 51 passed across restriction lifetime, pre-stream scope, restricted-root recovery, rearm, account holds and checkpoint acknowledgment.
- Full sidecar Python suite: 907 passed, 28 skipped; one existing Starlette/httpx deprecation warning.
- Required isolated PostgreSQL data-mechanics suites: 8 files, 109 passed, including `gdrive-admin-grant-policy`, `gdrive-identity-tombstone-email`, `gdrive-authority`, `identity-discovery-conflicts`, `gdrive-admin-credential-race`, `gdrive-admin-test`, `gdrive-oauth-lock-order` and `gdrive-complete-snapshot-overlap`. The isolated container was reset to ensure the R50 migration was loaded; its output confirmed `20261031140000_gdrive_restriction_generation_lifetime.sql` applied.
- Related unit tests: 6 files, 190 passed (`identity-conflicts-view`, GDrive lock/authority lock, grant policy, OAuth callback boundaries and credential fields).
- Real HTTP acceptance tests: 3 files, 12 passed (`gdrive-authority.http.test.ts`, `gdrive-broker-success.http.test.ts`, `gdrive-integrations-metadata.http.test.ts`). They ran against a uniquely named disposable Postgres 16 container on random local port 55005; the container was removed afterward. This was a targeted HTTP subset, not the complete HTTP tier.
- Production build: `npm run build` passed. Next 16.3 emitted four pre-existing warning classes about Node modules in Edge traces and the optional `@e2b/code-interpreter` package; compilation, type generation and route generation completed.
- `npm run typecheck`, ESLint on all changed TypeScript/TSX files, `npm run check:docs` (77 routes, 107 tables, 8 sources), and `git diff --check`: passed.
- `DATABASE_TEST_URL=postgres://app:app@localhost:<isolated-port>/app_test npm run test:migrate-from-existing`: passed from zero and through v0.7.0–v0.14.0, 2,243 catalog objects at every version, idempotent replays, populated replay and `schema.sql`/migrations mirror-check.
- The sidecar has no separate Dockerfile or container image declared in this repository. Its package contract is Python `>=3.11`. To verify the minimum runtime capability used by `state.py`, the official `python:3.11-slim` image at digest `sha256:673719e071ecf27434fd2635bbd8d00f49f4fdd81f243143438a42ced8bedf60` reported Python 3.11.18 / SQLite 3.46.1, and `json_each('[1,2]')` returned both rows. The current local Python 3.13.2 / SQLite 3.51.3 returned the same result. No production sidecar image is implied by this check.
- Full data-mechanics tier remains the previously recorded 314 files passed, 2 skipped and 2 environment-gated failures (`graph-tier` requires Neo4j; `staging-coordinator-lock-lifetime` requires the canonical live lock owner). Those failures are unrelated to this delta and are not represented as passes.

These checks verify implementation behavior but do not replace fresh independent R50 Fable review or the required fresh blind Astra and GPT-6.1 Sol reviews. The HTTP tier was targeted; live Google certification, production evidence and rollout gates remain open.


## Independent R50 review — Fable 5.1

- Exact source patch: SHA-256 `53c3d7068b1977e35fae8280475b05a24276dbc557fdd60b92fe71a65aaa37fd`; base `5ecd2989e21fded915b41b508477bb267aaec06d`.
- Reviewer: subscription-authenticated `claude-fable-5-1`, session `7618b881-663e-4587-96de-989a2900d887`, terminal success, 65 turns, no stderr, no source edits or tests. Filter metadata: `r50-fable-review.meta.json`. Curated report: `r50-fable-review-report.md`.
- Verdict: **changes required before blind final reviews**. Fable confirms R50 F1, F2, F5 and deferred F6 as implemented/not claimed. It identifies one High, three Medium and three Low findings; exact triggers, evidence and suggested regressions are in the curated report.
- Adjudication requested next: F4 High (nested document under deferred folder root can be removed without a verified listing); F3 Medium (a later binding quota/authority error can skip persisting an earlier root's Retry-After); F7 Medium (drain-phase account hold with failed checkpoint is neither reported as unpublished nor retried); F4 Medium (timeout-deferred root causes bounded but repeated whole-stream rescans). Low findings: rearm semantics for non-exhausted work, local fallback recorded as external minimum, and dispatch-deadline diagnostic label.
- Reviewer scope limit: although the report says it read all 37 patch paths, it did not re-review the earlier R47 Admin refresh/grant-policy TypeScript and did not inspect the root-coverage helper beyond its section read. Do not treat this as a whole-branch review or complete attestation; adjudicate any remaining coverage gap.

No source changes were made after the reviewed patch. The next action is a fresh GPT-6 Astra MEDIUM adjudication of the findings and bounded correction scope. Do not dispatch the Opus writer or the final blind reviews until that adjudication is recorded.
