# Coordinator verification — R51 F1–F3 correction delta

- Exact candidate base: `5ecd2989e21fded915b41b508477bb267aaec06d`; 53 source paths. Current manifest SHA-256: `b63dfb25efacd87fd5e5713897f7e635814a8cee9be006b9b2ddc47adb0abf53`. Tracked full-candidate patch SHA-256: `38513248999edf494bae690adc3e9f4727af41b78080321754b6bf19b6e77296`; untracked archive SHA-256: `a7b2f266bb3e8976273baee0728e51ab42f5b08663a17c75956cc80ee45bf5dd`.
- Current manifest compared to the last Fable-reviewed manifest; exact delta is listed in `delta-changed-files.json`.
- Focused F1–F3 regressions: 8 passed in 0.75s. Full ingestion suite under `TZ=UTC`: 1,030 passed, 28 skipped, one existing Starlette/httpx deprecation warning, 24.71s. The first sandboxed run failed only two local loopback-server fixtures at setup; approved full-user rerun passed both.
- No source paths changed during verification. Recovery checkpoint containing this handoff was pushed to `origin/codex/aio-1167-checkpoint-20261027` at `9ea7e64383d7fa972fe196ce0356b0db4c6825b6`, verified by independent `git ls-remote`.
- No live Google certification, multi-tenant UI evidence, 24-hour soak, or release approval is established.
