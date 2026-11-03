# Verification evidence — R51 stop-setup correction

Exact source candidate: `ed821d771cf1da1cbf78a3422b46e9dff3f76230` on `codex/aio-1167-google-docs-connector-rebased`; correction delta base: `b6628c3ed0f252d58259345c24178c75e4be9b16`; blind full-review base: `29676566a08280e12619b565711f9b0ff65271e0`.

Coordinator checks:

- `git diff --check`: passed before checkpoint.
- Focused watch suite: **96 passed in 2.94s** (`test_watch_late_quota.py`, `test_watch_lifecycle.py`, `test_watch_quota_hold.py`, `test_watch_operation_minima.py`). Running `test_watch_late_quota.py` alone also passed **36 tests in 1.08s**. Its existing abandoned-future cases emitted `Future exception was never retrieved` diagnostic text after passing.
- First full-ingestion run in the restricted sandbox: **1,112 passed, 28 skipped**; two `test_two_process_sidecars.py` setup errors were due to loopback bind permission.
- Approved loopback-enabled full-ingestion run: **1,114 passed, 28 skipped, one existing Starlette/httpx deprecation warning, 42.08s**.
- WIP checkpoint `ed821d771cf1da1cbf78a3422b46e9dff3f76230` pushed to recovery branch `origin/codex/aio-1167-r51-resume-20261102`; independent `git ls-remote` readback matched exactly. Pre-push docs-drift and skill-runtime hooks passed.

No production Google certification or 24-hour sandbox soak has run. No merge or deployment.

Fresh quota read before review dispatch: 2026-11-03 10:49:45 UTC / 16:19:45 Asia/Kolkata, `/usage` in the already-authenticated interactive Claude CLI. All-model week **60%**, Fable week **73%**, reset 5:30 p.m. Asia/Kolkata; credits **off**. This CLI view did not show a session-limit percentage. Do not interpret session token/cost totals as quota percentages.
