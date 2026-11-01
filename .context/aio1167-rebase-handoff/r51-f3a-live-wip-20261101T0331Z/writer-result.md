I've made the F3-A correction and extended the existing F3 regression. Nothing has been run: no tests, no docs, no commits, no pushes, no reviews. As in the last turn, the Grep tool wasn't available, so I used read-only shell commands (`find`, `cat`) to locate and read the adjudication bundle; they changed nothing.

## Changed paths
- `ingestion/aios_ingest/gdrive_sync.py`
- `ingestion/tests/test_deferred_folder_enumeration.py`

## Behaviour
In `absence_withheld`, a verified 404 for a root that is currently deferred is no longer recorded. The function sets `held = True` and skips `record_root_unavailable`, so the deferred marker stays.
- **Per-document callers:** for an ambiguous `removed` on a child, the removal is withheld and the existing caller sets `subtree_recovery_required`. The change page then starts the controlled replacement snapshot through the existing snapshot owner. That snapshot's open traversal records the 404 and closes the root's traversal empty.
- **Folder tombstones:** these share the helper and already set `subtree_recovery_required` before calling it. They now also withhold and recover through the replacement snapshot.
- **Unchanged:** a verified 404 on a root that isn't deferred still goes through `record_root_unavailable` as before. That function itself is untouched, explicit document trash still bypasses the helper, and no new owner was added.

## Test change
`test_a_deferred_folder_gone_after_its_placeholder_is_decided_by_a_replacement_snapshot` is now parametrized:
- **`no-per-document-change`:** the original scenario, with the same assertions as before.
- **`ambiguous-child-removal`:** before the SQLite restart, adds a `removed` change for `doc-a1` and no folder tombstone. It asserts:
  - in the run where the change page reads A's 404, A is still deferred, and that path is confirmed to have run;
  - no complete reconciliation includes `doc-a2` or any other A document, and last-success doesn't move until completion;
  - a replacement snapshot decides A, and A and its nested folder are never listed;
  - `doc-a1` isn't removed by the change page. It leaves through the replacement snapshot, and the other integration's claim on it remains;
  - the direct selection (`doc-direct`) and sibling folder B's documents remain, and the final reconciliation equals exactly the remaining documents.

The test detects the change-page read as a `("metadata", "folder-a")` call that comes after a `changes` call in the same run. That holds because the probe and baseline reads always happen before the change drain in a run.

## For you to run
- `ingestion/tests/test_deferred_folder_enumeration.py`: the whole file, including both new F3 cases.
- Regression neighbours for the shared helper:
  - `test_root_evidence_r49.py` (the duplicate-tombstone and change-page root-read cases);
  - `test_bound_root_loss.py`;
  - `test_deferred_root_scope.py`;
  - `test_explicit_trash_evidence.py`;
  - `test_restricted_removal.py`;
  - the folder-relocation and uncertain-root tests in `test_gdrive_upgrade.py`.
- The full sidecar suite.
