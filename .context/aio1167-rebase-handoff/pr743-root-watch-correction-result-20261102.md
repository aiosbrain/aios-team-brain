# PR743 — root and watch correction writer result

Date: 2026-11-02 UTC. Existing Claude Opus 5.5 HIGH session `628402d5-a1c6-42b7-b736-e84358c1a749`; the coordinator's safe watcher verified terminal `end_turn`, `is_error=false` at `2026-11-02T13:09:49.906Z`. The exact terminal transcript records no test run, commit, push, migration or review dispatch. It records one accidental no-op `echo`; no files were changed by it.

## Changed paths

- `ingestion/aios_ingest/state.py`
- `ingestion/aios_ingest/gdrive_sync.py`
- `ingestion/aios_ingest/watch_renewal.py`
- `ingestion/tests/test_lost_root_in_partial_build.py` (new)
- `ingestion/tests/test_watch_late_quota.py` (new)

No identity, OAuth, attribution, callback or PR714 Slack file was opened or changed in this slice.

## Implemented behavior and regression coverage

- The building-snapshot owner withdraws support for a verified-lost folder, preserving direct/overlapping/other-connection support and superseding only pending upserts tied to the affected snapshot. Restored folders with a closed empty traversal are deferred for a controlled rescan.
- Late quota exceptions from abandoned watch creation and stop workers are handed back to the StateStore event loop and recorded as monotonic holds for the verified current transport account. A hold prevents remaining same-account calls during the sweep; publication waits for the next fresh authority acquisition. Late successful creation remains cleanup evidence only.
- New root tests cover finished and unfinished traversals, SQLite reopen, empty change drain, overlap/direct/other-connection support, lost checkpoint acknowledgment and replay, and same-build folder restore. New watch tests cover creation/stop after timeout/cancellation, current-versus-historical account, in-sweep suppression, reopen/polling, monotonic holds, generation changes, no-op nonquota/cancelled/late-success outcomes, and worker cancellation before start.

## Writer-reported limits pending coordinator review

Direct-file root loss and change-page loss remain outside this folder-specific correction. An already-owed upsert may be sent before the folder probe observes absence; the final reconciliation is expected to retire its claim safely. Late local evidence can still be lost if its process/event loop exits before the callback is journaled; holds are per integration. Coordinator will assess these boundaries against the accepted adjudication and regression evidence.

No verification is claimed yet. `git diff --check HEAD` passed before this checkpoint. Focused tests, source review and full affected verification remain coordinator tasks.
