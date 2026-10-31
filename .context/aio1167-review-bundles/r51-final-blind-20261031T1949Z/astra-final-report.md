**Verdict: CHANGES REQUIRED.** Two confirmed defects from static code tracing.

1. **P1 — A deferred folder can become “complete” without being enumerated.**

   **Trigger:** A baseline/recovery run defers a selected folder, closes its traversal placeholder, then ends with another folder still unfinished. The next run resumes that snapshot after the deferred folder’s metadata becomes readable.

   **Actual:** [gdrive_sync.py:2857](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/ingestion/aios_ingest/gdrive_sync.py:2857) calls `settle_root(..., enumerated=True)` after only the metadata read. The placeholder previously completed at [gdrive_sync.py:2971](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/ingestion/aios_ingest/gdrive_sync.py:2971) remains completed, so traversal skips that folder. Deferred-root recovery is only considered when no snapshot is building ([gdrive_sync.py:2163](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/ingestion/aios_ingest/gdrive_sync.py:2163)).

   Once siblings finish, completeness checks accept the restored `bound` status. With fresh local state, retained membership is empty; unchanged documents under the skipped folder need not appear in subsequent changes. Complete-snapshot reconciliation consequently retires their existing claims ([source-reconcile.ts:205](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/lib/ingest/source-reconcile.ts:205)), potentially suppressing and purging valid content.

   **Expected / acceptance impact:** Keep the root deferred until its subtree is actually enumerated. This violates **AC-03, AC-05 and AC-07**: incomplete discovery can cause removals and false success.

   **Focused regression:** Recover with fresh SQLite, defer folder A, and exhaust the discovery budget while processing sibling B. Resume with A readable and an empty change feed. Assert A is listed and its existing documents survive before complete reconciliation is permitted.

2. **P2 — Watch requests discard newly received Retry-After deadlines.**

   **Trigger:** Watch creation or cleanup receives a quota response such as `429` with `Retry-After: 3600`.

   **Actual:** The new [watch_renewal.py:452](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/ingestion/aios_ingest/watch_renewal.py:452) gate honors previously recorded holds, but watch responses never establish one. Dispatch wraps 429 as `WatchRefused` ([gdrive_watch.py:139](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/ingestion/aios_ingest/sources/gdrive_watch.py:139)); [watch_renewal.py:352](/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/ingestion/aios_ingest/watch_renewal.py:352) retires the attempt and returns, allowing the next stream’s creation and subsequent cleanup immediately. Cleanup likewise records an attempt and continues at line 397. Neither path preserves the provider deadline for polling or restart.

   **Expected / acceptance impact:** Classify watch quota responses, persist/publish the account hold, and stop further calls until its deadline. Current behavior violates **AC-04’s Retry-After and bounded-recovery requirements**.

   **Focused regression:** Return 429 with a long Retry-After from the first watch request with two due streams and pending cleanup. Assert no subsequent watch, cleanup, or polling call occurs before the deadline, including after restart.

All 46 source hashes and the three bundle fingerprints matched. No tests were run or files modified. Live-certification evidence was not among the permitted inputs and was not assessed. This verdict is not readiness or publication approval.
