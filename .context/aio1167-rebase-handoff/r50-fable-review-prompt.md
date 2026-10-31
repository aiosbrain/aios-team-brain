# AIO-1167 R50 — independent read-only Fable 5.1 review

Review the exact R50 source delta below as an independent reviewer. Do not modify files, run commands or tests, commit, push, or publish. The verdict is about whether this R50 correction delta is ready for the required later blind final reviews; it is not merge or release readiness.

- Source worktree: `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree`
- Base: `5ecd2989e21fded915b41b508477bb267aaec06d`
- Complete R50 source patch (37 source paths, `.context/` excluded): `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/.context/aio1167-rebase-handoff/r50-review-source.diff`, SHA-256 `53c3d7068b1977e35fae8280475b05a24276dbc557fdd60b92fe71a65aaa37fd`
- Manifest: `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/.context/aio1167-rebase-handoff/r50-review-source.manifest.json`, SHA-256 `aa37aba6fadb569f5ce7d6af38b740d73c4f375302dfe4ee81941f29a3271587`

Read the complete patch and all 37 affected paths, then inspect relevant unmodified callers, state/authority owners, migrations, and consumers needed to verify the invariants. Review these authorities, treating the acceptance map as test evidence rather than proof:

- `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/.context/aio1167-rebase-handoff/accepted-spec.md`
- `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/.context/aio1167-rebase-handoff/astra-r49-adjudication.md`
- `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/.context/aio1167-rebase-handoff/r49-fable-review-report.md`
- `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/.context/aio1167-rebase-handoff/r50-opus-corrections-result.md`
- `/Users/chetan/.codex/worktrees/8d96/aios-team-brain/.context/aio1167-rebase-worktree/.context/aio1167-rebase-handoff/r50-acceptance-mapping.md`

Independently assess all accepted R50 corrections F1–F5 and F7, including:

1. Provider minimums surviving selection/credential generation transitions across the brain trigger/migration and sidecar SQLite, while generation-bound cursor, membership, lease, revision and stale-writer authority remain fenced. Check fresh-state recovery, empty-selection handling, account isolation, monotonic merge and whether restriction evidence can be waived or erased.
2. Explicit rearm clearing only local exponential backoff while preserving provider/control-plane minima and unknown legacy combined deadlines; unrestricted exhausted work becomes immediately eligible while ordinary polling remains bounded.
3. Pre-stream errors scoped to their actual operation (account quota, root metadata/relocation, one start-token stream, service-account identity prerequisite); valid Retry-After and unrepresentable minima remain owned at the narrowest scope; readable siblings continue without early retry or inferred absence.
4. Restricted-root recovery after 410 and fresh local state: preserve only proven membership, continue independently verified discovery/draining after baseline commit, keep the run partial and suppress absence reconciliation until unresolved roots are resolved, then verify restoration/removal behavior.
5. Existing different-owner identity conflicts checked before the tombstone return for automatic publication, with transaction rollback and unchanged normal tombstone behavior.
6. Truthful, deduplicated root-unavailable and unpublished-restriction diagnostics, including the real BrainClient lost-acknowledgment latch; no changed publication before reacquisition.
7. Migration replay safety, canonical `postgres/schema.sql` parity, target compatibility, sidecar `json_each` runtime assumption and existing privacy/authentication boundaries.

F6 (repeated permanent checkpoint refusal) was explicitly deferred by Astra; verify that R50 does not silently claim or implement it. Consider the writer’s recorded behavior boundaries (empty selection before verified account, removals waiting for verified root enumeration, bounded timeout-only rescans, loss of both local SQLite and unpublished evidence) against the accepted invariants, and distinguish acceptable limits from actionable gaps.

Return a substantive report with a clear verdict. For each finding include priority, exact file/line evidence, concrete trigger, expected versus actual behavior, impact, and a focused regression recommendation. State which paths and unmodified callers you inspected, coverage limitations, and whether any R50 acceptance criterion remains incomplete. Do not claim whole-branch review: this review covers only the delta from base `5ecd2989e21fded915b41b508477bb267aaec06d`.
