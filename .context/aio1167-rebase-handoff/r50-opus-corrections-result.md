**What you asked for (R50):** implement the Fable R49 findings Astra accepted (1–5 and 7) as the only writer, leave finding 6 deferred, add the real migration, update the architecture doc and acceptance mapping, and report changed files, ownership choices, open issues and exact test names. No shell, tests, commits or pushes.

All edits are uncommitted. **I did not run any test, migration replay, type check or lint**, and every result field in the mapping says `NOT RUN — coordinator`. This is not a readiness claim.

## Changed paths
- **New:** `postgres/migrations/20261031140000_gdrive_restriction_generation_lifetime.sql`
- **New:** `ingestion/tests/test_restriction_lifetime.py`, `test_pre_stream_scope.py`, `test_restricted_root_recovery.py`
- **New:** `.context/aio1167-rebase-handoff/r50-acceptance-mapping.md`
- **Modified:** `postgres/schema.sql` (the Slack block is untouched)
- **Modified:** `ingestion/aios_ingest/connector_state.py`, `state.py`, `gdrive_sync.py`
- **Modified:** `lib/identity/member-identities.ts`
- **Modified tests:** `ingestion/tests/test_checkpoint_acknowledgment.py`, `test_document_restrictions.py`, `test_account_hold_before_streams.py`, `test/datamechanics/gdrive-authority.datamechanics.test.ts`, `gdrive-identity-tombstone-email.datamechanics.test.ts`
- **Modified:** `docs/ARCHITECTURE.md` (the R49 text saying rearm keeps `not_before` and that a restricted root leaves the baseline incomplete is corrected)

## Key ownership choices
- **F1 (minimums outlive a generation):** a minimum is tied to the verified account and the provider's resource ID, not the generation.
  - Brain: when scope or credential changes, the database trigger now keeps exactly three sections: `account_hold`, `document_restrictions` and `retained_restrictions`. Everything else still resets, and stale workers are still refused.
  - Sidecar: the local SQLite lookups merge every generation (an unrepresentable minimum wins, then the later time).
  - Each run adopts only its own account's minimums. Other accounts' minimums are carried in `retained_restrictions`, neither adopted nor erased.
- **F2 (rearm):** two new `pending_work` columns record where a wait came from: `minimum_not_before` holds the provider's minimum, and `deadline_tracked` marks rows whose deadline is understood. Rearm resets the deadline to that minimum on those rows. Old rows without that record keep their combined deadline, because it can't be split safely. Restrictions are a separate owner and rearm never waives them.
- **F3 (pre-stream answers):** only a quota answer (429, or a 403 naming a rate limit) holds the whole account. Any other answer is scoped to what was being read:
  - a root's metadata or relocation read defers that root;
  - a start-token read defers that one stream (`start-token:<drive>`);
  - the service-account identity read defers that prerequisite (`prerequisite:service-account-identity`).
- **F4 (restricted root recovery):** a root that can't be read now is marked deferred (`uncertain` with a fixed detail prefix). Its page commits with only the membership the published snapshot already proved, which is none on fresh state, so nothing is invented. The run stays partial.
  - A change page can't clear a deferred root; only a fresh listing can.
  - Once no deferred root is still restricted, a controlled rescan lists it again.
- **F5 (tombstone):** a different existing owner is now checked before the tombstone early return. Automatic publication then raises the conflict error and the transaction rolls back.
- **F7 (diagnostics):** a missing root is counted once per run however many phases see it. `document_restriction_unpublished` is reported when a new or extended minimum isn't acknowledged. The upload-uncertainty latch is unchanged.

## Spec conflicts / unresolved points
1. The empty-selection path runs before the account is verified, so it carries minimums forward rather than adopting them.
2. Removals under a restricted root wait until it is listed again (deliberate under F4).
3. A root deferred by a timeout records no minimum, so a rescan may start every run until the root is read. Each rescan is bounded by the page budget, but it repeats.
4. Losing both the local SQLite file and unpublished minimums is still the documented durability limit.
5. Finding 6 is not implemented.

## Added tests
**Python**
- `test_restriction_lifetime.py`:
  - `test_a_generation_change_cannot_waive_a_document_minimum`, six cases: `[add-root|empty-then-reselect|same-account-reconnect]` × `[long|unrepresentable]`
  - `test_a_deselected_document_keeps_its_minimum_and_reselection_cannot_read_early`
  - `test_another_account_neither_inherits_nor_erases_the_original_accounts_minimum`
  - `test_an_account_hold_survives_a_scope_edit_and_a_same_account_reconnect[scope-edit|same-account-reconnect]`
- `test_pre_stream_scope.py`:
  - `test_a_quota_answer_on_initial_root_binding_is_the_accounts_hold[429|403-rate-limit]`
  - `test_a_root_503_with_a_long_retry_after_defers_that_root_alone`
  - `test_a_start_token_deferral_isolates_that_stream[503-long|timeout]`
  - `test_a_relocation_reread_answered_503_defers_that_root_alone`
  - `test_a_service_account_identity_503_defers_the_prerequisite_without_an_account_hold`
- `test_restricted_root_recovery.py`:
  - `test_after_a_410_rescan_a_restricted_file_root_is_deferred_and_independent_edits_flow`
  - `test_after_fresh_state_recovery_a_restricted_file_root_invents_no_membership`
  - `test_once_the_minimum_passes_the_deferred_root_is_listed_again_and_the_connection_completes`
  - `test_a_removal_while_restricted_is_applied_only_through_the_verified_path`
  - `test_a_root_verified_unavailable_twice_in_one_run_counts_once`
  - `test_root_unavailable_counts_deduplicate_across_phases_and_streams`
  - `test_a_newly_learned_restriction_no_checkpoint_carried_is_reported_unpublished`
- `test_document_restrictions.py` (these two replace the year-2099 test):
  - `test_rearm_drops_only_the_local_backoff_and_keeps_external_and_unknown_minimums`
  - `test_explicit_rearm_retries_exhausted_unrestricted_work_at_once_while_polling_stays_bounded`
- `test_account_hold_before_streams.py`:
  - `test_a_hold_for_another_account_does_not_hold_this_one`
  - `test_a_hold_observed_in_an_earlier_generation_still_holds_this_account`
- `test_checkpoint_acknowledgment.py`:
  - `test_a_new_restriction_under_a_lost_acknowledgment_is_kept_reported_and_never_republished_early`

**Database tests (data-mechanics)**
- `gdrive-authority`: "R50: a scope or credential transition keeps provider-minimum evidence, resets everything else, and still refuses the stale worker"
- `gdrive-authority`: "R50: the restriction-lifetime migration replays safely and its helper keeps only the three sections"
- `gdrive-identity-tombstone-email`: "R50 F5: an inconsistent tombstone hiding a different owner is the visible conflict, and nothing is published"

Stopping here for your verification.