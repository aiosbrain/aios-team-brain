# R51 cleanup-stop gate correction — coordinator verification

Date: 2026-11-03

## Snapshot and ownership

- Worktree: `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree`
- Sole implementation writer: existing Claude Opus 5.5 HIGH session `628402d5-a1c6-42b7-b736-e84358c1a749`; it completed successfully before coordinator review. It ran no tests, checks, commits or pushes.
- Exact source base: `84fd9b4d62eeacbbe977f45486692566a8661b53`.
- Only source paths changed by this correction: `ingestion/aios_ingest/watch_renewal.py` and `ingestion/tests/test_watch_late_quota.py`.
- PR714 ownership decision at `/Users/chetan/.codex/worktrees/b81f/aios-team-brain/.context/aio-1170-resume/aio1170-pr743-legacy-unlink-astra-decision-20261101.md` remains acknowledged: PR743 owns Google email identity equivalence/tombstones and repair; PR714 owns Slack suppression/generation/cutover. This watch correction does not touch either identity implementation.

## Correction

Cleanup stop admission now checks account quota hold and the channel-specific stop minimum on the StateStore owner loop before stop-worker work and again after the production manager's live authority check returns, immediately before the request. A late restriction or inability to confirm admission raises an explicit provably-unsent outcome. It leaves the channel `cleanup_pending`, preserves its resource and stop-attempt count, performs no publication or retry, and keeps the one-slot cleanup budget spent. An account hold or unconfirmed admission ends cleanup for this account/sweep; a channel-specific minimum skips only that channel. The live authority failure remains higher precedence. The module documentation now describes the stop gate.

Three production-manager interleaving regressions cover a late account quota hold, a late channel stop minimum with continuation to the independent channel, and authority failure precedence. Assertions verify the forbidden request is not executed, state and stop attempts remain intact, cursors do not move, and the restriction persists.

## Verification

- `git diff --check`: passed.
- From `ingestion/`, using the repository environment `./.venv/bin/pytest -q tests/test_watch_late_quota.py tests/test_watch_operation_minima.py tests/test_watch_quota_hold.py tests/test_watch_lifecycle.py`: **77 passed in 2.15s**.
- Two earlier collection attempts used the default Anaconda pytest and failed to import `aios_ingest`; these were environment/invocation errors, not test failures. The repository venv run above is the valid result.
- First full-suite run under the restricted sandbox: **1,093 passed, 28 skipped**, but two existing `test_two_process_sidecars.py` cases could not bind their loopback fixture (`PermissionError`). Repeated the identical suite through the approved local test path with loopback access: **1,095 passed, 28 skipped, one existing Starlette/httpx deprecation warning, 33.57s**.
- Fresh blind final reviews of the combined source delta from `29676566a08280e12619b565711f9b0ff65271e0` remain pending.

