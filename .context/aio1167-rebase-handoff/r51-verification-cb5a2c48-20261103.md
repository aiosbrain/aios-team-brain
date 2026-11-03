# R51 correction verification — candidate `cb5a2c48`

Date: 2026-11-03 UTC. Source candidate `cb5a2c4884128cf4eda36c13ab5e58084b732855`, diff base `5ecd2989e21fded915b41b508477bb267aaec06d`. Recovery checkpoint was pushed to `origin/codex/aio-1167-r51-resume-20261102` and independently read back at the exact candidate SHA.

## Checks

- `cd ingestion && .venv/bin/pytest -q tests/test_explicit_trash_evidence.py tests/test_operation_minima.py`: 29 passed.
- `bash scripts/dm-isolated.sh test/datamechanics/gdrive-identity-email-reader.datamechanics.test.ts`: 10 passed on this worktree's isolated Postgres 16 container.
- `bash scripts/dm-isolated.sh test/datamechanics/gdrive-identity-repair.datamechanics.test.ts`: 14 passed on the same isolated Postgres container.
- `cd ingestion && .venv/bin/pytest -q` via approved full-user path: 1,081 passed, 28 skipped; one unrelated Starlette deprecation warning.
- `npm run typecheck`: passed.
- `npx eslint lib/ingest/identity-repair.ts test/datamechanics/gdrive-identity-email-reader.datamechanics.test.ts`: passed.
- `git diff --check`: passed before the source checkpoint. Pre-push docs-drift and skill-runtime synchronization checks passed during the push.

The Opus writer ran no checks. These are coordinator-run results. The worktree was clean after the source checkpoint; no unrelated changes were included.

## Immutable review packet

Packet directory (local, ignored): `.context/aio1167-review-bundles/r51-final-20261103-cb5a2c48/`.

- 70 source/test/documentation paths; all per-file hashes reverified against candidate commit.
- Full diff SHA-256: `247fe30ae85cedc0a5e872c516f5186878f689b826f5b0cf2b4c86a596a00041`.
- Manifest SHA-256: `e6f9ee79a123be729365dd492a3b4d5f3a350f4900da0091acdcf7e9d4f05731`.
- Accepted spec SHA-256: `297ee1df91463fd0b6c4863b34be8b999ad176fc7d40f0637bf196660bd65e3d`.
- Repository AGENTS.md SHA-256: `e4117721d454be48f881a878037a07353ea7b355741e366169746276466bdb72`.
- Blind review prompt SHA-256: `ea23de574d8a109e510f17d9263ceaed5def73e56b92c68aad81fc032fead086`.

## Claude admission

Full-user interactive Claude.ai `/usage` at 2026-11-03 about 11:49 Asia/Kolkata: all-model week 55%, Fable week 66%, usage credits off, weekly reset 5:29 p.m. Asia/Kolkata. The UI did not show a separate session-utilization percentage. API-key and API-token environment overrides were unset. Subscription CLI auth is `claude.ai`, first-party Max. Both reported weekly windows are below the 90% stop threshold.

Live Google certification/sandbox evidence and the 24-hour soak remain open acceptance gates. Passing code checks and reviews will not substitute for those gates or authorize merge/deployment.
