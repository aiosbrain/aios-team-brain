# R51 Opus continuation — deadline and admission regressions

Continue in the same existing Opus 5.5 HIGH session `628402d5-a1c6-42b7-b736-e84358c1a749`; do not start another writer. Fresh Claude.ai `/usage` just before this correction was 59% all-model weekly, 72% Fable weekly, credits off. Stop before further work if any fresh applicable window reaches 90% or the provider refuses.

The current source checkpoint now contains the writer's partial implementation in `ingestion/aios_ingest/sources/gdrive_watch.py` and `ingestion/aios_ingest/watch_renewal.py`, saved in the latest remote recovery commit. Preserve and build on those edits. The coordinator has inspected the diff and run `git diff --check`; no tests have run, and no behavior is yet verified. Read `.context/aio1167-review-bundles/r51-stop-final-20261103-f3c4d3cb/adjudication.txt`, the current handoff, and the exact partial diff before continuing.

Complete the bounded test coverage only:

- Exercise the stop manager's absolute deadline guard with the real production manager: expiry while the provider gate/request setup is blocked, and a successful gate answer returned at/after deadline must never call `request.execute`.
- Exercise `_cleanup`'s `WatchNotDispatched` and `WatchStepTimeout` paths. A queued, blocked, or in-flight worker that reaches the absolute run deadline must end cleanup without a failed-attempt publication, checkpoint, retirement, or local projection mutation for `old0`; its resource and stop-attempt count remain unchanged. A request actually sent before abandonment remains conservatively pending; late quota/minimum evidence remains local until fresh authority.
- Correct the old stop-timeout fixture so it advances the real absolute deadline and releases workers without relying on a fabricated failed-attempt checkpoint.
- Cover the initial and post-authority admission failures on creation and stop. Assert no execution and unchanged acknowledged/checkpoint/local `old0` state (resource and attempts). Verify a timely never-sent creation result retires accurately. Do not assert no checkpoints in scenarios where another channel legitimately publishes; assert `old0` is preserved in each payload.
- Retain authority refusal precedence, account/unconfirmed sweep termination, per-channel minimum independent cleanup, one spent slot without retry/refund, and existing timely provider error/success behavior.

Inspect existing fixtures and call paths. Make test/helper changes only unless a test proves the just-checkpointed implementation incorrect; if so, describe the smallest behavior correction in your report and stop for coordinator review before expanding scope. Keep changes confined to existing watch test modules/helpers. Do not run tests or other commands, commit, push, or review. Return a concise report of exact files, tests added, and any unresolved coverage.
