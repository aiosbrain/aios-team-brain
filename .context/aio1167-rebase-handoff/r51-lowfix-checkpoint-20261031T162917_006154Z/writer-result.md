**What you asked for (R51 Lows):** in the same sole-writer session, make only Astra's two bounded Low fixes — (A) keep the hold outcome when an orderly-return checkpoint is refused with `stale_execution` or `connection_unavailable`, and (B) separate the brain's own Retry-After minimum from the client's local fallback. Then add their regressions and update the acceptance map, without running anything.

Both fixes and their regressions are written. **I ran no tests or commands**, so every new result in the acceptance map says `NOT RUN — coordinator`. Nothing is committed.

## Changed paths
- `ingestion/aios_ingest/gdrive_sync.py`
- `ingestion/aios_ingest/brain_client.py`
- `ingestion/tests/test_flush_authority_outcome.py` (new)
- `ingestion/tests/test_brain_minimum_provenance.py` (new)
- `.context/aio1167-rebase-handoff/r51-acceptance-mapping.md`

`scheduler.py` and `state.py` are unchanged; no change was needed in either. There are no TypeScript, Postgres or schema changes.

## A — terminal refusal keeps the hold outcome
- **Orderly-return flush:** when publishing unpublished hold or restriction evidence is refused with a terminal authority code, `_flush_restriction_evidence` no longer re-raises.
  - It now keeps the summary the run already built (hold category, counts, partial progress), reports the unpublished categories, and adds the authority code once as one failed outcome via a new helper, `_note_flush_authority`.
  - If an earlier cause already ended the run, it stays reported beside the new code. Exception text is never reported.
  - Every caller of the flush returns straight after it, so nothing further is read or checkpointed, and the coordinator still releases the lease.
- **Drain catch:** a terminal refusal of the drain-phase hold checkpoint now does the same. It keeps the progress made before the hold and the hold diagnostics, notes the unpublished categories, and returns immediately, skipping the end-of-run flush and any further reads or checkpoints.
- **Reporting:** scheduled and manual runs now report this summary instead of `coordinator_error`.
  - Status comes from the existing `_gdrive_outcome_status`: a refused standing-hold repair reports as `failed`, while a refused drain checkpoint after real progress reports as `partial`.
  - Because the summary carries the authority code, the scheduler's existing re-read still suppresses the report for a connection paused or disconnected meanwhile.

## B — brain-named minimum vs local fallback
- **`BrainDeferred`:** gains `provider_not_before`, which holds only the minimum the brain named in a valid Retry-After. A valid zero is recorded; no header, a malformed header, or an unanswered request leaves it empty. `not_before` stays the combined retry time, and the time actually slept is unchanged.
  - A new `_named_retry_after` supplies that value in `_backoff` and in the checkpoint retry path. The existing `_retry_after` is unchanged for its other callers.
- **Consumers:**
  - After a sink failure, `_record_sink_failure` uses the combined time only to delay the next attempt and records the brain-named part alone as the external minimum (`_fail_work` has a new `minimum=` argument).
  - After a document's content was accepted, a deferred checkpoint now stores `minimum=provider_not_before` instead of the combined time. It still costs no failure budget (`failure=False`), the obligation stays owed, and the uncertainty latch still stops the run.
  - Existing minimums and unknown legacy rows are preserved as before.

## Regressions added
**`test_flush_authority_outcome.py`** (each parametrized `[stale_execution|connection_unavailable]`)
- `test_a_terminal_refusal_at_standing_hold_repair_keeps_the_hold_outcome`
- `test_scheduled_and_manual_reports_carry_the_hold_outcome_not_a_coordinator_error`
- `test_a_terminal_refusal_of_the_drain_hold_checkpoint_keeps_progress_and_the_hold`
- `test_the_end_of_run_flush_keeps_accumulated_progress_and_an_existing_cause`

**`test_brain_minimum_provenance.py`**
- `test_a_brain_deferral_carries_only_the_brain_named_minimum[no-header|malformed|positive|zero]`
- `test_an_unanswered_request_fallback_names_no_minimum`
- `test_a_deferred_checkpoint_carries_only_the_brain_named_minimum_and_latches[no-header|positive]`
- `test_an_exhausting_sink_failure_on_local_fallback_leaves_no_minimum_and_rearm_reads_at_once[no-header|malformed|timeout]`
- `test_a_valid_positive_brain_minimum_survives_rearm`
- `test_a_valid_zero_brain_minimum_is_recorded_and_already_elapsed`
- `test_an_earlier_brain_minimum_is_never_erased_by_a_later_local_fallback`
- `test_non_exhausted_work_keeps_its_ordinary_backoff`
- `test_an_accepted_documents_deferred_checkpoint_records_only_a_brain_named_minimum[acknowledged-refusal|latched × local-only|brain-named]`

## Acceptance map
I added a section "R51 Low corrections" that marks only L1 and L2 as resolved in the implementation, and struck through earlier unresolved item 4, which A supersedes. R49 F6 is still deferred. H2, M-b/M-c/M-d, live Google certification and soak, opt-in/runner proof, canary and rollback all remain open. This is not a readiness claim.
