# AIO-1167 — fresh Fable 5.1 final-delta and coverage review

Perform a new, independent, READ-ONLY code review with subscription-authenticated Claude Fable 5.1. This review is required after the Astra-adjudicated R51 corrections and coordinator verification. Do not edit files, run commands/tests/builds, commit/push, contact external services, or start subagents. No output cap; concise findings must follow complete inspection.

## Frozen snapshot

- Base: `5ecd2989e21fded915b41b508477bb267aaec06d`.
- Complete reviewable source/test patch (all `.context/` handoff artifacts excluded): `.context/aio1167-review-bundles/20261031T153823Z-r51-final/review-source.diff`.
- Exact patch SHA-256: `8a1afd7dbc75b495e9c1086a29ce11fbd4a7474eb876e3f0e964b569bf2af27b` (218,980 bytes).
- Path list: `.context/aio1167-review-bundles/20261031T153823Z-r51-final/changed-files.txt` (40 source/test paths).
- Path/content manifest: `.context/aio1167-review-bundles/20261031T153823Z-r51-final/manifest.json`, SHA-256 `bdf2523e593dcc3c49ab3fed6dc5d04bc5ffa28468b3fc86c541b2469ae541b7`.
- Current source files and untracked regressions are available in the worktree. Verify current contents correspond to the frozen diff/manifest before relying on line numbers; do not run shell to do so.

Read `AGENTS.md`, accepted specification `docs/design/google-docs-connector-upgrade.md`, relevant architectural addendum, the complete current patch/manifest, and surrounding code/callers. Read `.context/aio1167-rebase-handoff/r51-acceptance-mapping.md` for observable criteria/results and `astra-r50-adjudication.md` for the precise accepted boundaries. Prior Fable reports are evidence maps only: independently verify the current code and do not accept writer or earlier reviewer claims without tracing implementation.

## Review scope

Review all 40 paths in the manifest. Follow relevant callers, shared contracts and consumers beyond changed lines, concentrating effort on behavior and integration risk. Confirm closure or report gaps for the R50 findings accepted by Astra: deferred nested membership cannot cause inferred removal; each binding Retry-After is journaled before subsequent short-circuits; unpublished drain holds and resource minima remain truthfully separate and recover after reacquisition without crossing the uncertainty latch; timeout-deferred roots use one bounded root-local probe per root per run before any whole-stream rescan; local fallback is not treated as a provider-owned minimum; dispatch and run deadlines remain distinct. Verify negative controls, root/stream/account isolation, overlapping claims, verified disappearance/restoration, freshness and eventual recovery. R49 F6 remains deferred and must not be claimed solved.

Fable's R50 report explicitly did NOT re-review earlier R47 Admin refresh/grant-policy TypeScript and did not fully inspect root coverage. Close this coverage gap on the exact frozen versions:

- Admin actions/callers and `refreshGoogleDriveAdminTestToken`, including authority capture and revalidation.
- `gdrive-grant-policy`, credential-field merging, OAuth publication and broker policy.
- Omitted-scope fallback; broadened or downgraded grants; manual-root and Picker verification; token confidentiality; credential revision/race/revocation checks; and the same grant ceiling in Admin and execution.
- Root-evidence construction and checkpoint acknowledgment → locked root-coverage gate → claim retirement, traced with direct per-document removal and overlapping-root/cross-connection claims. Confirm a complete-snapshot guard cannot stand in for the direct-removal safety rule.

Use these related regressions as evidence where relevant, and inspect whether they really exercise the boundary: `gdrive-admin-grant-policy.datamechanics.test.ts`, `gdrive-admin-credential-race.datamechanics.test.ts`, `gdrive-admin-test.datamechanics.test.ts`, `gdrive-authority.datamechanics.test.ts`, `gdrive-oauth-lock-order.datamechanics.test.ts`, `identity-discovery-conflicts.datamechanics.test.ts`, `gdrive-complete-snapshot-overlap.datamechanics.test.ts`, plus R51 `test_deferred_root_scope.py` and `test_restriction_publication_recovery.py`. The coordinator recorded the exact tests and results in the acceptance map. Do not infer security properties from tests alone.

## Required response

Return a clear verdict (`changes required`, `hold`, or `no actionable findings in the reviewed scope`). List actionable findings first. For each include severity, exact current file/line, triggering scenario, expected versus actual behavior, impact, evidence across callers/contracts and a concrete regression recommendation. Separate correctness findings from rollout/environment gates and speculative risks.

Then provide a coverage ledger for every path in the supplied 40-path manifest, marked FULL / PARTIAL / UNREAD with evidence. Add an explicit ledger for the Admin/grant-policy and root-coverage interactions above. If any material path or interaction remains uninspected or cannot be verified against this exact snapshot, say HOLD and enumerate it. Do not claim full-branch or whole-repository coverage beyond what you actually inspected.
