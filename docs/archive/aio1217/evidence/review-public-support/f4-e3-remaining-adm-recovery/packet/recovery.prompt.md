# AIO-1217 — finish the interrupted prospective F4-E3 remaining-ADM fixture slice

You are a fresh actual subscription-authenticated `claude-opus-5-5` HIGH continuation of the same test-only builder role. You are not a reviewer, fallback, new architecture owner, or restart of the prior CLI session. The prior run used no session persistence and cannot resume. Its partial source is retained at a clean local WIP checkpoint; inspect and finish that retained work rather than recreating, resetting, reverting, or replacing it.

## Current state, not completion

- Repository/worktree: `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree`
- Branch: `codex/aio-1217-server-action-auth`
- Required clean local WIP checkpoint: `d8427efdfc3498a167e3b4155ca22b9278d5eb29`
- Current remote branch: `2437df69f2146e84a646a46f288c555dd2ad032a`; the local WIP is intentionally unpushed.
- Target base remains `c5e832c2ff179ee5c99f95966fba1ed9ce77ae3e`.
- Sole writable file: `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-worktree/test/datamechanics/aio1217-pm-reconcile-action-native.datamechanics.test.ts`
- Required current fixture SHA-256: `7ae552da7d3d637a5c545caca92322f7f3330294c696cabf7de1873bc42e3407`; 200,634 bytes.
- Current addition from pushed `2437df69...`: exactly one 56,102-byte insertion after case 10 and before the existing Z/history block. Parent proved every old byte is the exact 136,595-byte prefix plus exact 7,937-byte suffix. Current raw patch SHA-256: `61235d43666574cd360666e5bfe58714d2c0c0e4a9f11c59089ba51c5db4334e`.
- The interrupted builder was actual `claude-opus-5-5` HIGH session `759558bf-501b-48ad-b2f0-a538e5cf7140`, no denials, no subagents. It inserted cases 11–15, then was interrupted and reaped with terminal `error_during_execution` / `aborted_streaming`; it returned no completion token and ran no checks. Its final text only said it was writing the insertion. Treat it as incomplete.
- Do not infer wall-clock duration: the wrapper recorded monotonic 859 seconds while the parent observed UTC advance from about 03:02 to 04:30. Preserve both facts without reconciling them.

Exact recovery manifest: `/Users/chetan/.codex/worktrees/2b54/aios-team-brain/.context/aio1217-handoff/review-public-support/f4-e3-remaining-adm-recovery/packet/manifest.json`.

Read the full repository AGENTS instructions, canonical shared workflow skill, accepted v9, Astra disposition, current Next Server Actions guide, the original 33-input builder prompt/manifest, the entire current fixture including insertion and unchanged surrounding code, and every relevant exact source identified by the recovery manifest. The original manifest's `9297...` fixture identity is historical input to the interrupted launch; the recovery manifest's `7ae552...` current fixture identity supersedes it. Do not reject or overwrite the retained partial source merely because the old manifest names the pre-edit hash.

## Tools and write boundary

Use only `Read,Glob,Grep,Edit,Write`. No Bash, tests, lint, typecheck, PG, network, MCP, git, commit, push, Linear/PR action, or nested workers. Do not create, rename, delete, or edit any other file. `Write` is not permission to replace the fixture wholesale or create a report file.

If an input, checkpoint, fixture identity, or single-writer premise mismatches, stop without editing and report `SOURCE_IDENTITY_BLOCKED`. If exact supplied source reveals a consequential architectural, shared-contract, or security ambiguity, report `ASTRA_HIGH_REQUIRED` with the smallest exact question; do not invent policy or edit runtime source.

## Shortest recovery assignment

First inspect the retained insertion as code, not as a completed builder claim. Trace each helper and each case against the supplied real session, resolver, guard, posture, schema, association, owner and transport sources. Confirm the insertion is syntactically coherent by reading its declarations/usages and fits the existing fixture's types and seams. Then do one of two things:

1. If the retained source already completely and coherently satisfies the contract below, make **no edit** and return the required completion report.
2. If you find a concrete omission, contradiction, type/syntax problem or assertion that does not follow from the supplied source, make only the smallest exact correction inside the existing contiguous cases-11–15 insertion. Preserve all pre-existing bytes outside that insertion and preserve already-correct partial work. Do not refactor or rewrite for style.

Do not edit merely to manufacture activity. Conversely, do not declare completion just because five cases exist.

## Completion checklist

Verify every required arm is actually present and source-supported:

- Case 11: genuinely invalid non-empty session cookies rejected by the real verifier, exact cookie-only trace and no effects, paired with a real admitted native provider-read control. Missing-cookie coverage remains case 3; no unsupported session policy is invented.
- Case 12: verified memberless user; every schema-supported inactive member status (the supplied schema currently declares `invited` and `disabled`, not `suspended`); active same-team role-`lead`; exact stopping reads, identifier bindings and durable no-effects; paired native admitted control.
- Case 13: both stale legacy-tier directions—legacy `team` without builtin Everyone refuses, legacy `external` with builtin Everyone admits—read back from real rows. The admitted direction must reach actual native owner/provider reads and effects; this observes association-derived posture without blessing inconsistent legacy data.
- Case 14: same-session active admin admitted, builtin Everyone association removed, a fresh invocation refused with no request effects, association restored, and a further fresh invocation admitted non-vacuously. Setup row changes must remain separate from request effects; legitimate admitted link/audit/revalidation effects must be attributed precisely.
- Case 15: reverse-team positive binding. Each admin's foreign-slug refusal remains exact, while Bob at team B's own slug resolves/decrypts/reads/rewrites/audits/revalidates team B only; no team A identifier, secret or row is carried or changed. A subsequent team-A control proves its rows remained live.
- Every refusal uses the actual exported action and real `getSessionUser → verifySession → resolveIntegrationsAdmin → resolveViewerPosture → canAccessAdmin`; no mocked guard verdict or substituted reconciliation owner.
- Whole request traces, client acquisition counts, exact DTO/key shapes, real stored premises, foreign binding absence, provider tripwires, complete relevant durable rows/timestamps and non-vacuous positive controls are asserted. Helper predicates alone are insufficient.
- Cases 1–10, all pre-existing helpers, observer/recording behavior, header/prose and Z/history/TODO bytes remain exact. Stale historical TODO prose is intentionally preserved and must not be rewritten in this slice.
- No production/runtime/schema/helper/setup/documentation change, historical admission waiver, E4 acceptance, UI/E6, full-E3/full-task/final, PR/merge/deployment or Done claim.

Resolve ordinary test mechanics from supplied source. Do not decide new semantics for ADM, membership status, association posture, legacy tier, session validity, tenant confinement, exception policy or provider behavior. Any consequential conflict routes to Astra HIGH.

## Required final

Return substantive final text containing exactly one of these terminal markers:

- `E3_REMAINING_ADM_RECOVERY_COMPLETE` when the retained fixture is complete, whether you needed no edit or made a bounded fix; or
- `ASTRA_HIGH_REQUIRED` / `SOURCE_IDENTITY_BLOCKED` when applicable.

For completion, also state:

- whether you made no edit or the exact minimal edit made;
- the single authorized fixture path and confirmation no other path was created/edited;
- a checklist disposition for cases 11–15 and the exact source files used;
- confirmation that all bytes outside the existing insertion were preserved;
- `NOT RUN`: no PG, test, lint, typecheck, review, commit or push claim;
- any remaining limitation.

Do not compute or guess a new hash. The parent will verify the actual diff and hash after your successful terminal result. If you make no edit, the expected fixture remains `7ae552...`; if you edit, all later check/campaign artifacts must bind the newly computed hash. No helper pinned to `9297...` or any earlier fixture may be reused.
