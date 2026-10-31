# AIO-1167 R51 — acceptance mapping (Astra R50 adjudication, bounded corrections)

Writer: Claude Opus 5.5 HIGH, session `628402d5-a1c6-42b7-b736-e84358c1a749` (same sole writer).
Inputs: `astra-r50-adjudication.md` (SHA-256 `8be1cbb60fdd0d462f14c316a5584d20987f96c81fe21ec248d0d2811b328791`);
frozen R50 patch SHA-256 `53c3d7068b1977e35fae8280475b05a24276dbc557fdd60b92fe71a65aaa37fd` on base
`5ecd2989e21fded915b41b508477bb267aaec06d`; `r50-acceptance-mapping.md` (its R50 rows and coordinator
results are unchanged and do NOT attest this delta).

**No test, typecheck, lint, build or migration was run by the writer.** Coordinator verification is recorded below. No schema, TypeScript or Postgres production change was made. This is not a
whole-branch review or coverage claim, and makes no readiness claim. R49 F6 remains DEFERRED.
The R47 Admin refresh / grant-policy paths were not touched and remain unreviewed by Fable — a
coverage gap for the next independent reviewer, together with root evidence → checkpoint → locked
root-coverage gate → claim retirement, and the direct-removal and overlap paths.

Pytest ids for stacked parametrize are `[<nearest-decorator id>-<outer id>]`.

## 1. High — deferred folder ancestry / inferred removal

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Nested selected doc under a deferred root (timeout) is held — no remove obligation, membership drop, sink removal or reconciliation; root stays deferred; no rescan for the held change; sibling edit flows | `gdrive_sync` change classifier: `deferred_here` (`StateStore.deferred_roots`) ∩ `membership_roots`, `held_by_deferred_root` → `deferred_root_document_held` | `test_deferred_root_scope.py::test_a_nested_edit_under_a_timed_out_root_is_held_when_the_root_then_reads_present` | PASS — full sidecar suite |
| Same when the root's provider minimum lapses between admission and page classification; then restoration completes, nothing removed | same | `test_deferred_root_scope.py::test_a_nested_edit_is_held_when_the_roots_minimum_lapses_between_admission_and_classification` | PASS — full sidecar suite |
| Persistence (reopened SQLite), overlapping direct claim proceeds and keeps both roots, new unknown/unrelated docs never added (no widening), fresh SQLite invents nothing | same | `test_deferred_root_scope.py::test_held_scope_persists_across_reopen_keeps_overlap_and_never_widens_or_invents` | PASS — full sidecar suite |
| After verified enumeration: root settles, nested update flows, a real move-out is reconciled only by the verified complete snapshot (never inferred removal) | existing controlled rescan + `settle_root(enumerated=True)`; complete-snapshot gate | `test_deferred_root_scope.py::test_after_verified_enumeration_the_nested_edit_flows_and_a_real_move_out_reconciles` | PASS — full sidecar suite |
| Verified root loss / restoration, duplicate removal, stale pending upsert, cross-connection claims | unchanged R48/R49/R50 owners | existing Python cases `test_root_evidence_r49.py`, `test_bound_root_loss.py`, and `test_restricted_root_recovery.py::test_a_removal_while_restricted_is_applied_only_through_the_verified_path`: PASS — full sidecar; `gdrive-complete-snapshot-overlap.datamechanics.test.ts`: PASS — isolated Postgres, 1 file / 1 test |

## 2. Medium — binding Retry-After ordering

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Earlier root's long 503 minimum journaled before a later 429 / quota-403 / nonterminal BrainError / terminal authority refusal / local deadline; published on the orderly return (kept locally + `document_restriction_unpublished` + original error under terminal authority); not read again before its minimum, on the same and (published) fresh state | `_bind_selected_roots(observe=)`, coordinator `observe_root_minimum`, `report_deferred_roots`, `_flush_restriction_evidence(cause=)`, `_open_account_hold` (now always flushes) | `test_restriction_publication_recovery.py::test_an_earlier_roots_named_minimum_survives_a_later_short_circuit[429]`, `[403-quota]`, `[brain-error]`, `[authority]`, `[local-deadline]` | PASS — full sidecar suite |
| Ordering contract at the helpers (binding and stalled relocation): minimum handed to the journal before the next root's read | `_bind_selected_roots(observe=)`, `_reobserve_stalled_relocations(observe=)` | `test_restriction_publication_recovery.py::test_binding_hands_each_minimum_to_the_journal_before_the_next_root_is_read`; `::test_the_relocation_reread_hands_each_minimum_to_the_journal_before_the_next_read` | PASS — full sidecar suite |
| Failed publication retained locally and reported per owner; repaired on reacquisition (standing-hold early return, no provider call); fresh state then honours it | `_publish_restriction_evidence`, `_note_unpublished`, standing-hold `_flush_restriction_evidence` | `test_restriction_publication_recovery.py::test_a_failed_publication_is_kept_reported_per_owner_and_repaired_on_reacquisition` | PASS — full sidecar suite |

## 3. Medium — drain account-hold publication recovery

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Hold vs resource compared separately, distinct categories, once per run (also across merged stream summaries) | `_restriction_outstanding`, `_standing_holds`/`_standing_resources`, `_note_unpublished`, `_merge_summary` | covered by the rows below and `[authority]` above | PASS — full sidecar suite |
| Drain quota + checkpoint 503 before commit: local hold kept, `account_hold_unpublished` once, checkpoint error (`server_error`) kept, no provider call after; reacquisition repairs before returning with no provider call, siblings preserved; fresh SQLite honours | drain `_ProviderAdmissionClosed` handler (`setdefault(exc.code)`), end-of-run `_flush_restriction_evidence`, standing-hold flush | `test_restriction_publication_recovery.py::test_a_drain_phase_hold_whose_checkpoint_fails_is_reported_once_and_repaired_before_any_call` | PASS — full sidecar suite |
| Real BrainClient latch: hold committed, acknowledgment lost; nothing further sent (incl. end-of-run publication); truthful diagnostics; fresh-state reacquisition adopts the committed hold with no provider call | `_publish_restriction_evidence` latch short-circuit (`_progress_uncertain`) | `test_checkpoint_acknowledgment.py::test_a_drain_hold_committed_under_a_lost_acknowledgment_is_reported_and_adopted_with_no_early_call` | PASS — full sidecar suite |
| No-commit loss with surviving journal → reacquisition → publication → fresh-state restore | same | the drain-phase row above (checkpoint fails before commit, journal survives) | PASS — full sidecar suite |

Not claimed: recovery when neither the brain nor the local journal retained the observation (R49 limitation).

## 4. Medium — timeout deferred-root amplification

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| ≥3 polls with the deferred root timing out, state reopened between: one root-local probe per run, no sibling listing, sibling edits drain, retained nested docs stay, partial; then repaired → complete | `_deferred_root_admissible(source=, probed=, diagnostics=)`, coordinator `deferred_root_probes`, routine `probe_report` | `test_deferred_root_scope.py::test_a_root_that_keeps_timing_out_is_probed_once_per_poll_and_siblings_are_never_relisted` | PASS — full sidecar suite |
| Failed probe with a named minimum records it; standing minimum → zero probes while independent changes drain | same + `_restrict_resource` | `test_deferred_root_scope.py::test_a_probe_answered_with_a_named_minimum_records_it_and_no_further_probe_is_made` | PASS — full sidecar suite |
| Quota answer to the probe is the account's hold | same (`_account_hold`) | `test_deferred_root_scope.py::test_a_quota_answer_to_the_probe_is_the_accounts_hold` | PASS — full sidecar suite |

The probe never settles the root; a located root only authorizes the existing controlled rescan.
This supersedes R50 boundary 3 (repeated rescans for a timeout root).

## 5. Low — provider vs local deadline provenance; Run now boundary

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Timeout / malformed-Retry-After fallback on the exhausting failure: delays the attempt but no external minimum, no restriction; rearm makes it eligible at once; polling does not read exhausted work | `_fail_work(external=)`; drain passes `external=provider_deadline` | `test_document_restrictions.py::test_a_local_fallback_on_the_exhausting_failure_is_backoff_that_rearm_drops[timeout]`, `[malformed-retry-after]` | PASS — full sidecar suite |
| Non-exhausted work keeps its backoff through Run now (accepted boundary, negative control) | `rearm_exhausted` (unchanged) | `test_document_restrictions.py::test_run_now_keeps_the_backoff_of_work_that_is_not_exhausted` | PASS — full sidecar suite |
| Valid/unrepresentable provider minimum, brain-named deferral minimum, unknown legacy row stay protected | unchanged | existing R49/R50 rearm and restriction tests | PASS — full sidecar suite |

## 6. Low — deadline diagnostics

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Drain: exact `dispatch_deadline` / `run_deadline`, no hold/restriction, no failure charged, still owed | `_drain_pending` local-deadline branch | `test_document_restrictions.py::test_a_local_deadline_in_the_drain_keeps_its_own_category_and_charges_nothing[dispatch_deadline]`, `[run_deadline]` | PASS — full sidecar suite |
| Stream start-token seam keeps the category | `_stream_start_deferred` | `test_document_restrictions.py::test_a_local_deadline_on_a_streams_start_token_keeps_its_own_category[dispatch_deadline]`, `[run_deadline]` | PASS — full sidecar suite |
| Coordinator start-token local stop (already exact) | `_open_account_hold` | existing `test_account_hold_before_streams.py::test_a_local_budget_stop_opens_no_hold` | PASS — full sidecar suite |

## Unresolved / for the reviewer

1. The F1 hold applies only to a document already selected whose out-of-scope classification rests on
   unknown ancestry under a deferred root; an explicit provider tombstone for such a document is still
   treated as before (Astra: keep explicit removal rules). A folder control-plane change under a
   deferred root still seeds the existing subtree recovery.
2. A held nested edit is not ingested until the root's verified enumeration (accepted by Astra).
3. The F4 probe is per run at coordinator level (`deferred_root_probes`); direct callers of the stream
   routine without the coordinator get a per-call set.
4. ~~A terminal authority refusal met while publishing on an orderly return WITHOUT a prior BrainError
   is still raised~~ — superseded by the R51 L1 correction below: it is now reported beside the run's
   accumulated outcome, never raised as a generic coordinator error.
5. No migration-number or schema change; no new owner, retry service, outage detector or override.

## Coordinator verification attempt 1

- Focused Python command across the four R51 test modules: **44 passed in 1.82s**.
- Full sidecar `.venv/bin/pytest -q`: **928 passed, 28 skipped, 1 failed, 2 errors in 20.74s**. The failure is the stale `dispatch_deadline` expectation in `test_drain_recovery.py::test_budget_expiry_between_metadata_and_docs_is_local_and_untouched`; the two setup errors are loopback `PermissionError` in `test_two_process_sidecars.py` under sandbox denial. Details and exact next action are in `r51-coordinator-verification.md`. No R51 check is yet a full-suite pass.


## Coordinator verification — corrected snapshot

- R51 focused modules plus `test_drain_recovery.py`: **59 passed in 2.32s**.
- Full ingestion sidecar: **931 passed, 28 skipped, 1 existing Starlette/httpx deprecation warning in 21.64s**. Run with normal approved loopback so the two-process tests executed. The previous sandbox attempt and one stale expectation correction are retained in `r51-coordinator-verification.md`; neither is counted as the final result.
- `gdrive-complete-snapshot-overlap.datamechanics.test.ts`: **1 file / 1 test passed** on isolated Postgres 16.
- `npm run check:docs`: passed (77 routes, 107 tables, 8 sources); `git diff --check HEAD`: passed.
- No R51 TypeScript or Postgres production owner changed. R50 `typecheck`, build, ESLint, migration and related HTTP/authority suites remain previously verified for their unchanged owners. Re-run them if the fresh review or later corrections changes those owners/contracts.
- Fresh Fable review and Astra adjudication are still pending; no whole-branch or release-readiness claim.


## R51 Low corrections (Astra `astra-r51-low-adjudication.md`) — focused verification passed; full sidecar pending

Input snapshot: base `5ecd2989e21fded915b41b508477bb267aaec06d`, pre-correction patch SHA-256
`8a1afd7dbc75b495e9c1086a29ce11fbd4a7474eb876e3f0e964b569bf2af27b` (40 paths; Fable: no actionable
High/Medium, no HOLD). The coordinator verification above attests that pre-correction snapshot only.
**The writer ran no test or command. Coordinator focused verification now passes (78 tests); the full sidecar run remains pending.** Only L1 and L2
are resolved in the implementation. R49 F6 stays DEFERRED (before unattended rollout); H2,
M-b/M-c/M-d, live Google certification/soak, opt-in/runner proof, canary and rollback stay open. No
TypeScript, Postgres, schema or `scheduler.py` change: scheduled/manual status follows the existing
`_gdrive_outcome_status` classification and the existing pause/disconnect re-read.

### L1 — terminal checkpoint refusal at an orderly return keeps the hold outcome (resolved in implementation)

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| Standing-hold repair refused with `stale_execution` / `connection_unavailable`: summary keeps hold category, adds the authority code once and both unpublished categories; local hold and restriction persist; no provider read; no later checkpoint; lease released | `_flush_restriction_evidence` (no re-raise; `_note_unpublished` + new `_note_flush_authority`) | `test_flush_authority_outcome.py::test_a_terminal_refusal_at_standing_hold_repair_keeps_the_hold_outcome[stale_execution]`, `[connection_unavailable]` | PASS — focused R51 low-fix suite (78 passed) |
| Scheduled and manual reports carry that summary (no `coordinator_error`), status = existing classification; paused/disconnected re-read still suppresses | `scheduler._poll_job` / `_manual_gdrive_job` (unchanged) | `test_flush_authority_outcome.py::test_scheduled_and_manual_reports_carry_the_hold_outcome_not_a_coordinator_error[stale_execution]`, `[connection_unavailable]` | PASS — focused R51 low-fix suite (78 passed) |
| Equivalent drain catch: `closed.partial` progress and hold diagnostics kept, authority code + `account_hold_unpublished` reported, run returns at once (no end flush, no further read/checkpoint); status `partial` beside progress | coordinator `_ProviderAdmissionClosed` handler (`authority_lost`) | `test_flush_authority_outcome.py::test_a_terminal_refusal_of_the_drain_hold_checkpoint_keeps_progress_and_the_hold[stale_execution]`, `[connection_unavailable]` | PASS — focused R51 low-fix suite (78 passed) |
| End-of-run flush keeps accumulated counts/categories; an existing nonterminal cause stays beside the distinct flush authority code | `_flush_restriction_evidence`, `_note_flush_authority` | `test_flush_authority_outcome.py::test_the_end_of_run_flush_keeps_accumulated_progress_and_an_existing_cause[stale_execution]`, `[connection_unavailable]` | PASS — focused R51 low-fix suite (78 passed) |

Retained: a terminal `cause` still suppresses publication entirely (unpublished noted); exception text
is never reported; existing pre-correction tests for terminal causes are unchanged.

### L2 — brain-named minimum separated from local BrainClient fallback (resolved in implementation)

| Requirement | Owner | Regression | Result |
|---|---|---|---|
| `BrainDeferred.provider_not_before` carries only the brain-named Retry-After (valid zero included); absent for no header / malformed; `not_before` stays the combined local eligibility | `brain_client.BrainDeferred`, `_named_retry_after`, `_backoff` | `test_brain_minimum_provenance.py::test_a_brain_deferral_carries_only_the_brain_named_minimum[no-header]`, `[malformed]`, `[positive]`, `[zero]` | PASS — focused R51 low-fix suite (78 passed) |
| Unanswered-request (timeout) fallback names no minimum | `_timeout_backoff` | `test_brain_minimum_provenance.py::test_an_unanswered_request_fallback_names_no_minimum` | PASS — focused R51 low-fix suite (78 passed) |
| Checkpoint deferral carries only the brain-named minimum; uncertainty latch unchanged | `checkpoint_gdrive_execution` | `test_brain_minimum_provenance.py::test_a_deferred_checkpoint_carries_only_the_brain_named_minimum_and_latches[no-header]`, `[positive]` | PASS — focused R51 low-fix suite (78 passed) |
| Exhausting sink failure on local fallback (503 without header, malformed header, timeout): no external minimum; rearm → eligible at once | `_record_sink_failure` → `_fail_work(external=False, minimum=provider_not_before)` | `test_brain_minimum_provenance.py::test_an_exhausting_sink_failure_on_local_fallback_leaves_no_minimum_and_rearm_reads_at_once[no-header]`, `[malformed]`, `[timeout]` | PASS — focused R51 low-fix suite (78 passed) |
| Controls: valid positive minimum survives rearm; valid zero recorded and already elapsed; earlier minimum never erased; non-exhausted work keeps ordinary backoff | `_fail_work(minimum=)`, `StateStore.fail_work` monotonic merge (unchanged), `rearm_exhausted` (unchanged) | `test_brain_minimum_provenance.py::test_a_valid_positive_brain_minimum_survives_rearm`; `::test_a_valid_zero_brain_minimum_is_recorded_and_already_elapsed`; `::test_an_earlier_brain_minimum_is_never_erased_by_a_later_local_fallback`; `::test_non_exhausted_work_keeps_its_ordinary_backoff` | PASS — focused R51 low-fix suite (78 passed) |
| Accepted-content checkpoint deferral: local-only minimum absent (brain-named recorded), failure budget unchanged, obligation retained, latch honoured; immediate rearm eligibility NOT demanded | `_push_doc` checkpoint branch (`minimum=provider_not_before`, `failure=False`) | `test_brain_minimum_provenance.py::test_an_accepted_documents_deferred_checkpoint_records_only_a_brain_named_minimum[acknowledged-refusal-local-only]`, `[acknowledged-refusal-brain-named]`, `[latched-local-only]`, `[latched-brain-named]` | PASS — focused R51 low-fix suite (78 passed) |

Unknown legacy minima (`deadline_tracked=0`) and the wait actually slept are unchanged; this does not
implement R49 F6.
