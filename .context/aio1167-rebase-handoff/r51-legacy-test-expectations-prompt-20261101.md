# Bounded R51 legacy-test expectation update

You are the existing sole Opus 5.5 HIGH implementation writer for AIO-1167. Apply only test expectation/comment corrections required by the already accepted R51 Astra adjudication. Do not edit production code, architecture docs, unrelated tests, or the held identity/tombstone slice. Do not run tests, commit, push, or dispatch reviewers; the coordinator owns checks, checkpoints, publication, and review routing.

Current candidate worktree: `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree`.

The coordinator's full sidecar run passed 1017 tests, skipped 28, and found four failures attributable to obsolete assertions plus one known UTC/IST clock-window failure. Focus this turn only on these three test functions / four parametrized cases:

1. `ingestion/tests/test_gdrive_upgrade.py::test_document_the_provider_says_is_gone_is_removed_at_once_behind_a_peer_that_cannot_be_opened[trashed]`
2. `ingestion/tests/test_gdrive_upgrade.py::test_stale_claim_of_a_recovery_blocked_peer_does_not_swallow_a_confirmed_deletion[trashed-accepts]` and `[trashed-fails-once]`
3. `ingestion/tests/test_watch_lifecycle.py::test_dispatch_classifies_not_sent_refused_and_unknown_outcomes`

The accepted explicit-trash correction persists verified trash before parent-root absence gating, routes it through claim-aware reconciliation without provider metadata reads, and retains ambiguous deleted/access-lost behavior. Update only the `trashed` test branches/comments/assertions to expect no `("metadata", "doc-1")` call while preserving prompt removal, durable cleanup failure/retry, surviving peer claim, and all deleted/access-lost controls.

Watch HTTP 429 and recognized quota 403 now raise `WatchQuotaLimited(deferral)` so the existing account restriction owner can persist Retry-After. The test's 429 case should assert `WatchQuotaLimited` with the expected rate-limited deferral; ordinary 400/403/404 refusals and 500/408/timeout unknown outcomes must retain their current assertions. Dedicated `test_watch_quota_hold.py` already covers Retry-After parsing and renewal enforcement.

Before editing, inspect the exact current test bodies and relevant accepted correction mapping. Keep the diff limited to those existing test functions. Return the changed paths, exact behavioral assertions updated, and any mismatch with the adjudicated contract. Do not claim tests pass; the coordinator will run them.
