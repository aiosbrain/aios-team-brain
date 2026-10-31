# Coordinator verification

- The exact current candidate is based on `5ecd2989e21fded915b41b508477bb267aaec06d`, with 53 source paths (27 modified tracked, 26 untracked). The full manifest, tracked diff and untracked archive are included.
- All 53 per-file hashes, the manifest hash, tracked-diff hash, untracked-archive hash, and all 26 archive members matched the source worktree at freeze. The exact manifest SHA-256 is `419fdf79ca384e58fcd54b5a7c25da5a67c717273881ed45b1f97483825ee91a`; tracked patch SHA-256 `fb4f8d6ebc1817d0f76292069a3b92c20ce5b779fb081c3e4803cd903cd010c8`; untracked archive SHA-256 `f0a9d8fec533f743251dd17ab68128790788e61430ec589db9bd75e6ad6bb4c0`.
- Delta against the previous Fable-reviewed manifest: 14 paths (7 modified and 7 added). See `delta-changed-files.json` for exact previous/current hashes.
- Coordinator `git diff --check HEAD` passed. The three adjusted legacy test functions passed **10/10**. Full sidecar suite under `TZ=UTC`: **1022 passed, 28 skipped**, one existing Starlette/httpx deprecation warning. Isolated real-PostgreSQL `gdrive-audience-claims.datamechanics.test.ts`: **17/17 passed**.
- These checks do not establish live Google sandbox certification, multi-tenant UI evidence, a 24-hour soak, or release readiness.
