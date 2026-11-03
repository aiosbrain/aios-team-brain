# Bounded correction — R51 stop deadline follow-up

Resume the existing sole Opus 5.5 HIGH writer session `628402d5-a1c6-42b7-b736-e84358c1a749`. Do not create another writer. Exact accepted candidate: `b6628c3ed0f252d58259345c24178c75e4be9b16`; current worktree may have later handoff-only commits. Read repository `AGENTS.md`, accepted spec and these durable records:

- `.context/aio1167-rebase-handoff/r51-fable-deadline-adjudication-20261103.md`
- `.context/aio1167-rebase-handoff/r51-fable-deadline-review-20261103/review-report.md`
- `.context/aio1167-review-bundles/r51-stop-deadline-final-20261103-b6628c3e/fable-delta/accepted-spec.md`
- `.context/aio1167-review-bundles/r51-stop-deadline-final-20261103-b6628c3e/fable-delta/prior-adjudication-context.txt`

Make only these two accepted corrections:

1. In the deterministic cleanup deadline sweep tests in `ingestion/tests/test_watch_late_quota.py`, assert via `caplog` that no warning from the watch-renewal module with prefix `Drive watch renewal for gd stopped:` appears during the first sweep. This must make removal of the explicit `WatchNotDispatched` and `WatchStepTimeout` handlers fail the regression. Filter by the relevant logger and prefix; do not require globally empty logs. Reuse the controlled-clock fixture and assert before the recovery sweep.
2. In `GoogleDriveWatchManager.stop()` / cleanup, treat only the known `_service(deadline)` construction errors `MissingExtraError` and credential `ValueError` as provably pre-dispatch. Convert them at that boundary into a distinctly handled no-dispatch outcome. Cleanup must leave that channel's state/resource/attempt count/local projection unchanged, make no request, publish nothing, retain the already reserved one-slot budget, and continue to independent channels. The next iteration must still enforce absolute deadline and remaining budget; do not retry that channel in the same sweep. Do not catch broadly around the authority gate or request execute. Preserve raw `BrainError` precedence, `_StopNotSent` scope handling, quota/minimum handling, timely success/404 and genuine provider-failure accounting, and all creation behavior.

Add the adjudicated production-manager regression: parameterize `MissingExtraError` and credential `ValueError` for old0, with three cleanup channels and two slots. Assert no old0 request execute; old0 state/resource/attempts unchanged in brain, every payload and local projection; old1 is successfully stopped; old2 is untouched. Keep existing deadline, authority-precedence, timely success/404, and provider-failure regressions intact.

Do not run tests, lint, typecheck, git commands, commit, push, or start a review; the coordinator owns these. Make no unrelated changes. When complete, return `end_turn` with a concise file-by-file report, exact accepted behaviors, and any limitation. Continue this exact writer session only after the coordinator confirms fresh Claude.ai subscription `/usage` below 90% and API-key/token overrides unset. The source snapshot is being handled by one coordinator; no other writer is authorized.

## Coordinator admission evidence — 2026-11-03

The user-provided Claude `/usage` screenshot captured at 4:01:22 p.m. Asia/Kolkata shows current-week all-model usage **60%** and Fable usage **73%**, both resetting Nov 3 at 5:30 p.m. Asia/Kolkata. No session utilization percentage appears in the screenshot. Full-user `claude auth status` in this continuation confirms `loggedIn:true`, `authMethod=claude.ai`, `apiProvider=firstParty`, subscription Max; the command explicitly unset `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`. The latest explicit usage display said credits are off, and no action has enabled them. The displayed applicable windows are below 90%; coordinator admits this existing Opus session for the bounded correction.

Durable screenshot: `.context/aio1167-rebase-handoff/quota-evidence/claude-usage-20261103-160122.png`; SHA-256 `906eec88d75815cc9be6f8be8205f3258c7be88a99f97fd2ca157ad9864e2280`.
