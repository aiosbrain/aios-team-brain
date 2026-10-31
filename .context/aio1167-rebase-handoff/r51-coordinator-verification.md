# AIO-1167 R51 coordinator verification — attempt 1

Snapshot at this verification: feature base/HEAD `5ecd2989e21fded915b41b508477bb267aaec06d`; full R50+R51 working diff SHA-256 `6f3e3f890b0a49cda31d6901adbbe983455b62cd4f26c0b3588d4a386e4419c7`. The completed writer snapshot and untracked tests are preserved remotely at recovery commit `25d40f8783abadcfeb46b8496eb02473b7e706c7`.

- Focused command from `ingestion/`: `.venv/bin/pytest -q tests/test_deferred_root_scope.py tests/test_restriction_publication_recovery.py tests/test_document_restrictions.py tests/test_checkpoint_acknowledgment.py`
- Focused result: **44 passed in 1.82s**.
- Full sidecar command from `ingestion/`: `.venv/bin/pytest -q`
- Full result: **928 passed, 28 skipped, 1 failed, 2 errors in 20.74s**; existing Starlette/httpx deprecation warning.
- The one failure is `tests/test_drain_recovery.py::test_budget_expiry_between_metadata_and_docs_is_local_and_untouched`: input raises `ProviderDeferred(... category="dispatch_deadline")`, but the old assertion still expects `{"run_deadline": 1}`. R51's accepted contract requires preserving the actual category, and the new targeted parameterized test checks both `dispatch_deadline` and `run_deadline`. Bounded correction: update this stale assertion to `dispatch_deadline` only; preserve the separate run-deadline control. No production defect is established by this failure.
- The two errors are setup-only `PermissionError: [Errno 1] Operation not permitted` at `ThreadingHTTPServer.bind(127.0.0.1,0)` in `tests/test_two_process_sidecars.py` (2 tests), caused by sandbox loopback denial. No test body ran. Rerun the full suite after the assertion correction through normal elevated approval for loopback; do not call these passing.
- No source files changed during either test run. Typecheck, lint, build, Postgres/protocol tiers and review are still unrun for R51.

Next: the same Opus writer makes only the bounded test expectation correction in `ingestion/tests/test_drain_recovery.py`, with no test command. Coordinator then recaptures/checkpoints and reruns focused plus full sidecar with the required loopback permission, recording fresh exact outcomes.
