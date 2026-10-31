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

## Verification after the bounded assertion correction

- Corrected focused command: `.venv/bin/pytest -q tests/test_deferred_root_scope.py tests/test_restriction_publication_recovery.py tests/test_document_restrictions.py tests/test_checkpoint_acknowledgment.py tests/test_drain_recovery.py` — **59 passed in 2.32s**.
- Full sidecar rerun with normal approved loopback access: `.venv/bin/pytest -q` — **931 passed, 28 skipped, 1 existing Starlette/httpx deprecation warning in 21.64s**. Both earlier loopback setup errors executed successfully.
- `bash scripts/dm-isolated.sh test/datamechanics/gdrive-complete-snapshot-overlap.datamechanics.test.ts` — **1 file / 1 test passed** on isolated Postgres 16.
- `npm run check:docs` passed (77 routes, 107 tables, 8 sources); `git diff --check HEAD` passed.
- No R51 TypeScript or Postgres production source changed. The R50 typecheck/build/ESLint/migration/authority/HTTP results remain valid for unchanged owners; rerun those if a review or later correction changes those owners/contracts.
- Fresh source-only review patch excluding `.context/`: base `5ecd2989e21fded915b41b508477bb267aaec06d`, SHA-256 `8a1afd7dbc75b495e9c1086a29ce11fbd4a7474eb876e3f0e964b569bf2af27b`, 40 paths. Fresh Fable 5.1 review is the next gate; no whole-branch/readiness claim yet.


# R51 Fable review attempt 1 — interrupted, no verdict

- Review target: exact source-only patch SHA-256 `8a1afd7dbc75b495e9c1086a29ce11fbd4a7474eb876e3f0e964b569bf2af27b`, base `5ecd2989e21fded915b41b508477bb267aaec06d`.
- Fresh subscription Fable 5.1 CLI run started read-only with `Read, Glob, Grep` allowlist, `dontAsk`, no session persistence, first-party subscription (`apiKeySource=none`). It read the accepted specification, full patch/manifest, R51 map/adjudication, R51 Python regressions, root coverage, grant policy, credential fields, Admin actions/tests, OAuth authority and source-reconciliation dependencies.
- At about 14 minutes, the safe event monitor observed assistant `Write` and `Edit` calls against Claude's local project-memory directory (`~/.claude/projects/.../memory/state-encoded-as-a-detail-prefix.md` and `MEMORY.md`). This exceeded the explicit read-only review boundary. I interrupted the CLI. Safe monitor returned `error_during_execution`; no final review verdict exists. This invocation is not counted as a completed review.
- The feature source snapshot stayed unchanged. The CLI created/modified only the named local Claude memory files outside the repository; I did not restore or edit those files to avoid overwriting their prior user state. No raw stream or tool arguments were sent to another worker.
- Next: retry the same exact Fable review only after fresh usage, with `--disallowedTools Write Edit Bash`, `--strict-mcp-config`, and only `Read Glob Grep` allowed. Do not use memory-writing tools. If another write attempt is observed, interrupt and report the actual blocked review path rather than risking further side effects.
