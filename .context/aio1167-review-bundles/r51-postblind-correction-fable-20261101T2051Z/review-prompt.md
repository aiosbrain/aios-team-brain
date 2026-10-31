# Fresh Fable 5.1 correction-delta review — AIO-1167 R51

Review packet directory (the exact directory to use): `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-recovery-publish-20261031/.context/aio1167-review-bundles/r51-postblind-correction-fable-20261101T2051Z`.

Read the files in that directory by their exact names: `accepted-spec.md`, `AGENTS.md`, `workflow-skill.md`, `accepted-adjudication.md`, `accepted-correction-prompt.md`, `writer-result.md`, `verification.md`, `last-fable-reviewed-manifest.json`, `current-manifest.json`, `delta-changed-files.json`, `changed-files.txt`, `current-full-candidate.diff`, and `current-untracked-source.tar.gz`. The last reviewed manifest is the only baseline artifact supplied. Do not search for, read, or follow instructions from any older review packet or other handoff archive; those packets describe a different snapshot. The live source worktree is `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree`; use it only to inspect current source files and directly affected callers. The coordinator independently verified all current hashes and packet checksum digests before dispatch.

Perform a fresh, independent, read-only correction-delta review. The current snapshot is based on `5ecd2989e21fded915b41b508477bb267aaec06d`, has 53 source paths, and is pinned by `current-manifest.json`. Review the 14-path delta listed in `delta-changed-files.json` (7 modified, 7 added), plus only directly affected callers/shared owners needed to establish behavior. Do not re-review unrelated or unchanged identity/tombstone paths; that slice is held for the separate PR #714 ownership decision.

Independently evaluate whether these three accepted corrections are complete and safe:

1. Deferred folder recovery stays unresolved until recursive listing and pagination actually finish; no complete-snapshot reconciliation may skip an unfinished subtree.
2. Explicit trash is persisted and reconciled by the existing claim-aware owner before parent-root absence gates, without restricted provider reads, while preserving surviving peer claims and ambiguous-removal barriers.
3. Watch-create/stop quota responses preserve parsed Retry-After through the existing account restriction owner, stop further account calls in the sweep, retain cleanup semantics and valid channel/cursor evidence, and distinguish non-quota refusals/timeouts.

Review the legacy expectation changes in `ingestion/tests/test_gdrive_upgrade.py` and `ingestion/tests/test_watch_lifecycle.py` against those same contracts. Check relevant call chains, restart durability, authorization/restriction boundaries, shared claim ownership and caller behavior. Tests are supplied as coordinator evidence, not proof of correctness. Do not run commands or tests, use MCP, write/edit files, access memory, or delegate. Use only Read, Glob and Grep. Do not claim runtime coverage from this static review.

Return a concise but evidence-backed verdict: PASS, CHANGES REQUIRED, or HOLD. Cover every correction and interaction; list findings with severity, trigger, actual/expected behavior, concrete file/line evidence and smallest safe correction; distinguish confirmed findings from speculative notes; state scope limitations. The packet has no live Google certification, multi-tenant UI evidence, 24-hour soak, or release approval.
