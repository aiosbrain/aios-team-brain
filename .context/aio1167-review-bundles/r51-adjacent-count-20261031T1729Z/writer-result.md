# R51 adjacent-count writer result

- Model/session: `claude-opus-5-5` / `628402d5-a1c6-42b7-b736-e84358c1a749`; subscription-backed first-party (`apiKeySource=none).
- Result: `success`, `is_error=False`, `36` turns, `281404` ms.
- Token metrics: uncached input `36`, cached-read `11362058`, cache creation `1370143`, output `22518` (thinking `5546`).
- No tests or commands were run by the writer.

**What you asked for (R51 adjacent run-count correction):** use one explicit `run_failure_counted` signal, separate from `cause`, so a run that has failed is counted as failed only once across the no-streams/unresolved-root and active-drain paths. Add the three regression groups for both authority codes, and update only the relevant acceptance-map rows with results left PENDING.

The fix, regressions and map rows are written, uncommitted. **I ran no tests or commands.** I also created one stray file by mistake; it needs deleting (see the first item under open points).

## Changed paths
- `ingestion/aios_ingest/gdrive_sync.py`
- `ingestion/tests/test_flush_authority_outcome.py`
- `.context/aio1167-rebase-handoff/r51-acceptance-mapping.md` (Note A row and a new adjacent-correction section)

## Behaviour
- **New signal:** the coordinator keeps a local `run_failure_counted`. It is set only where the coordinator itself counts the run as failed:
  - the binding `BrainError` catch;
  - unresolved selected roots (`selection_root_unresolved`);
  - the `selection_unresolved` arm;
  - the start-token `BrainError` catch;
  - a reconciliation failure that is not just deferred.
  
  It is never inferred from `total.failed`, from categories, or from document failures.
- **Where it is passed:** to `_flush_restriction_evidence` at the binding catch, the no-streams return, the start-token catch and the end of the run; through `_open_account_hold` on the start-token quota path; and to the drain catch's `_note_flush_authority`.
  - When the flag is set, a terminal refusal still adds its authority category and the unpublished categories once each, but does not add a second failure.
- **`cause`:** it now does only one job, suppressing publication when the cause is a terminal refusal. Note A's earlier coupling (`charge=cause is None`) is replaced by the explicit flag.
- **Unchanged:** distinct diagnostics, local evidence, accumulated progress, the immediate stop after a refusal, status classification and scheduling. No counter caps.

## Regressions (not run; each parametrized `[stale_execution|connection_unavailable]`)
1. **No streams**
   - `test_no_streams_with_unresolved_roots_and_a_refused_flush_is_one_run_failure`: one root returns a 503 with a long Retry-After, the other a 404; the flush is refused.
   - `test_the_selection_unresolved_arm_and_a_refused_flush_is_one_run_failure`: bounded fixture with nothing selected and a minimum pre-seeded in the local journal.
2. **Unresolved root plus active drain**
   - `test_an_unresolved_root_beside_a_drain_whose_hold_checkpoint_is_refused_is_one_run_failure`
3. **Controls**
   - `test_a_terminal_refusal_of_the_drain_hold_checkpoint_keeps_progress_and_the_hold` now asserts `failed == 1` explicitly.
   - The no-cause flush control in `test_the_end_of_run_flush_keeps_accumulated_progress_and_an_existing_cause` is unchanged.
   - New: `test_an_independent_document_failure_stays_counted_beside_the_one_authority_charge` expects `failed == 2` (one document failure plus one run failure) and `incomplete_extraction == 1`.

The binding-catch no-later-call assertion and Note B stay deferred.

## Open points
- **Stray file to delete:** I accidentally created `ingestion/tests/_r51_tail_placeholder.txt`. It is now empty, but my tools cannot delete files. Please remove it before checkpointing. pytest will not collect it.
- **Reachability of the `selection_unresolved` test:** it assumes a run with no selected roots reaches the no-streams branch with no earlier exit and no provider call. I could not confirm that without running it. If an earlier validation returns first, the test will fail; that would mean the arm is unreachable in practice, not that the fix is wrong.
- **Pre-existing, left alone:** after the unresolved-root charge, a start-token `BrainError` still adds its own `failed += 1`. That double count comes from the coordinator's own charges, not from a flush, and Astra's adjudication did not name it. I set the flag there but did not change that count.
- **Status:** I can't give a diff hash without commands.
- R49 F6, H2, M-b/M-c/M-d, live Google certification and soak, opt-in/runner proof, canary and rollback all remain open. No whole-branch readiness claim.
