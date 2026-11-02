# PR743 — root/watch coordinator verification

Candidate checkpoint: `7424d0a4ab545922d2470d4e80370682112d2799` (source and test changes; pushed to `origin/codex/aio-1167-r51-resume-20261102` and independently read back).

- `./.venv/bin/pytest -q tests/test_lost_root_in_partial_build.py tests/test_watch_late_quota.py` from `ingestion/`: **13 passed in 2.50s**.
- `./.venv/bin/pytest -q tests/test_deferred_folder_enumeration.py tests/test_bound_root_loss.py tests/test_deferred_root_scope.py tests/test_root_evidence_r49.py tests/test_explicit_trash_evidence.py tests/test_restricted_removal.py tests/test_watch_lifecycle.py tests/test_watch_quota_hold.py tests/test_watch_account_hold.py` from `ingestion/`: **111 passed in 4.52s**.
- `git diff --check HEAD`: passed before source checkpoint.
- Ruff was not available in this venv (`.venv/bin/ruff` missing); no lint result is claimed.

The root regression file exercises finished/unfinished folder traversal, empty change drains, support overlap, independent claims, reopening SQLite, checkpoint refusal/acknowledgment loss, replay, and restoration. The watch regression file exercises late quota from create/stop after timeout/cancellation, held-account suppression, loop ownership, reopen/polling, account scope, monotonic deadlines, and inert cancelled/nonquota/late-success outcomes.

These are focused affected-slice results, not full ingestion-suite verification. The accepted identity corrections and fresh final reviews remain outstanding.
