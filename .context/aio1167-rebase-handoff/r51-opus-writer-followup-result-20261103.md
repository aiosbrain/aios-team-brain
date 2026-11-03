# Opus writer follow-up result

- Timestamp: 2026-11-03T05:33:11.720Z
- Model: claude-opus-5-5

I've fixed the full-suite regression, closed an ordering gap that A1 had introduced, and added the requested gap tests. Nothing was run: no test suites, typecheck, lint, build, commit or push. I used three read-only shell commands (`grep` and `sed`) to locate code.

## The regression fix
The A4 post-sweep step was publishing every outstanding restriction, including a late account hold journaled in that same sweep. That broke the established rule: a late quota is journaled locally and blocks later calls at once, but publishes only on the next fresh acquisition.
- `ingestion/aios_ingest/gdrive_sync.py`: `_restriction_evidence`, `_restriction_sections` and `_publish_restriction_evidence` take a new `local_holds` flag that defaults to `True`, so every existing caller behaves as before. With `False`, the published document carries the brain's already-acknowledged account holds unchanged and adds only local operation minima.
- `ingestion/aios_ingest/watch_renewal.py`: a new `_publish_watch_operation_minima` replaces the post-sweep publication call.
  - It does nothing unless an operation minimum is outstanding, and then publishes with `local_holds=False`.
  - A timeout, a failed or lost acknowledgment, or an authority refusal keeps the local journal and is logged, not raised.
- The timely-quota path (`_publish_watch_restrictions`) and the fresh-acquisition hold publication are unchanged.

## A1 ordering fix (found while writing these tests)
My earlier A1 change let a document with no local membership get a trash removal even when a later change in the same page restored it. Nothing would have superseded that removal, so restored content could be suppressed.
- In the change-page loop, a change carrying a file body now records the document's latest trashed state.
- Before materializing the page, a trash removal is dropped if the document's last observation in that page is not trashed.
- A bare `removed` without a file body never counts as a restore.

## Tests added (all pending; none run)
- **Publication separation, late operation worker, and publication failures** (`ingestion/tests/test_watch_operation_minima.py`):
  - `test_operation_minima_publish_in_the_sweep_while_a_late_account_hold_waits_for_the_next_acquisition`;
  - `test_a_late_operation_minimum_from_an_abandoned_create_worker_is_journaled_and_gates`;
  - `test_a_failed_or_lost_operation_minimum_publication_keeps_the_journal_and_republishes`, with a delivery failure and a lost acknowledgment;
  - `test_a_create_minimum_survives_a_failed_lost_or_stale_outcome_publication`, with a delivery failure, a lost acknowledgment and a stale fence.
- **A1, Python** (`ingestion/tests/test_explicit_trash_evidence.py`):
  - `test_with_no_local_membership_trash_then_restore_in_one_page_removes_nothing`, which also checks that a later re-trash does remove;
  - `test_membershipless_trash_still_respects_the_durable_queue_bound`: the page isn't materialized, the cursor doesn't move, and nothing is reconciled.
- **A1, PostgreSQL owner:** the existing explicit-trash case in `gdrive-audience-claims.datamechanics.test.ts` covers per-connection retirement, last-claim suppression and replay. It didn't cover the case A1 now makes reachable, so I added "trash reported by a connection holding NO claim is a no-op for other connections and teams (A1)". It checks that another connection's claim and the team epoch stay unchanged, and that another team's report can't reach this team's claim.
- **A3** (`ingestion/tests/test_operation_minima.py`):
  - `test_a_listing_minimum_survives_a_same_account_reconnect_that_keeps_the_store`;
  - `test_a_listing_minimum_whose_acknowledgment_was_lost_is_honoured_from_the_brain`: the brain stores the restriction, the acknowledgment is lost, and a fresh store after a scope edit still never lists the folder early.
- **A5** (`test/datamechanics/gdrive-identity-exact-unlink.datamechanics.test.ts`): "a remap committed while the exact unlink waits on the identity authority wins: nothing is removed". It uses real transactions: the unlink is refused as stale, and the remapped row, its state and the absence of a removal audit are all checked.

## Remaining gaps
- **A3, A→B→A not covered:** the `_DriveWorld` harness has no clean way to switch verified accounts, so I didn't write that test rather than write a fragile one. Separately, a failed (not just lost) publication followed by a *fresh* store loses the minimum, because it exists only in the discarded local journal. That's an inherent limit of local-then-publish, not a regression.
- **A1, multi-page replay not testable here:** `_DriveWorld` returns all changes in one page, so I couldn't build true multi-page replay. The queue-bound test stands in for it.
- **A1, cross-page restore:** for a document with no local membership, a restore in a *later* page still yields no superseding upsert. If the trash removal has already drained, the content returns only when root recovery lists the document again. Only same-page ordering is fixed.
- **Queue-bound test size:** it creates `_MAX_PENDING_PER_STREAM + 1` documents, which could be slow if that constant is large.
- **Not run:** all suites, typecheck, lint, build, and `git diff --check`.
