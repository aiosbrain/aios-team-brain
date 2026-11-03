# R51 watch dispatch gate correction — coordinator verification

Updated: 2026-11-03 07:20 UTC.

## Snapshot

- Candidate: `84fd9b4d62eeacbbe977f45486692566a8661b53`
- Parent: `29676566a08280e12619b565711f9b0ff65271e0`
- Feature branch: `codex/aio-1167-google-docs-connector-rebased`
- Recovery branch: `origin/codex/aio-1167-r51-resume-20261102` — `git ls-remote` read back the candidate SHA.
- Changed source/test files: `ingestion/aios_ingest/watch_renewal.py`, `ingestion/tests/test_watch_late_quota.py`.

## Accepted correction

Blind Astra HIGH and GPT-6.1 Sol HIGH reviews of prior candidate `29676566` independently found that the admission callback ran before `manager.dispatch`, while production client construction and its live-authority provider gate could block afterward. A quota hold or drive-specific creation minimum journaled during that gate could be missed before `request.execute`.

The sole Opus 5.5 HIGH writer updated `_create` to pass a composed gate to the production create dispatch. The authority gate runs first; then `confirm_admission` reads the restriction owner on the event loop through the existing bounded bridge. A restriction, timeout, or unavailable answer raises `WatchNotDispatched` before the request call. The earlier admission before manager/client work remains. Scope is create only; no stop path, schema, identity or PR714 behavior changed.

Two deterministic production-manager cases block inside the authority gate, release an abandoned worker’s quota or same-drive minimum onto the loop, then release the gate. Assertions cover zero `request.execute` for the restricted drive, truthful retirement with no resource, retained restriction, unchanged predecessor/cursors, account hold stopping all account watch calls, and a drive minimum allowing an independent drive.

## Verification

- Focused: `.venv/bin/pytest -q tests/test_watch_late_quota.py tests/test_watch_lifecycle.py tests/test_watch_quota_hold.py tests/test_watch_operation_minima.py` from `ingestion/`: **74 passed in 1.93s**.
- Full: `.venv/bin/pytest -q` from `ingestion/`, normal approved full-user execution: **1,092 passed, 28 skipped, 1 existing Starlette/httpx deprecation warning, 46.15s**.
- `git diff --check`: passed before commit.
- Pre-push hooks: docs drift passed (77 routes, 107 tables, 8 sources); skill runtimes in sync (8 published skills).

## Reviews and remaining gates

Fresh blind final reviews of exact candidate `84fd9b4d62eeacbbe977f45486692566a8661b53` by subscription-authenticated Fable 5.1, Astra HIGH and GPT-6.1 Sol HIGH are pending. Previous candidate-specific P2s are not verdicts on this snapshot. Production Google certification and a 24-hour soak remain open. No merge or deployment occurred.

PR714 identity decision acknowledged: PR743 owns Google `author-email:` equivalence/tombstones and Google repair; PR714 retains Slack suppression/generation/cutover.

## Fresh admission

At 2026-11-03 07:20 UTC the full-user Claude.ai CLI reported logged-in first-party subscription access with API key/token environment overrides unset. `/usage`: all-model week 56%, Fable week 68%, credits off. Both applicable reported weekly windows are below 90%.
