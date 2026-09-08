<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Local Linear access

For AIOS Linear work, load `LINEAR_API_KEY` from `/Users/chetan/Projects/chetan-aios/.env` and use the installed AIOS toolkit’s `scripts/linear.mjs` CLI. Never print, copy into source, or commit the key or the `.env` file.

## Anthropic coding authentication

Never use an Anthropic API key for coding. Always use Claude through subscription-authenticated access, including delegated coding and builder fallbacks. If subscription access is unavailable or reaches a limit, do not switch to API-key billing; use an authorized alternative builder or report the blocker.

## Durable work and recovery checkpoints

- Never keep the only copy of implementation work, an active worktree, review findings, or verification records under `/tmp`, `/private/tmp`, `$TMPDIR`, or another automatically cleaned directory. Use a durable, ignored directory inside the repository (for example, `.context/<task>-worktree` and `.context/<task>-handoff`) or an approved persistent workspace. Confirm the directory is ignored before placing local artifacts there.
- Before a long review or test run, a model/builder handoff, a pull/rebase, or another major phase transition, create a recoverable local checkpoint of all task-owned changes, including untracked files. Use a scoped local WIP commit, or a retained stash/backup whose successful capture is verified. Do not checkpoint secrets, generated dependencies, or unrelated user changes. Record the checkpoint commit/object ID in the durable handoff; never rely on uncommitted files alone for hours of work.
- During active editing, create and verify a checkpoint at least every 10–15 minutes, in addition to the phase-transition checkpoints above. Check worker status and available usage at major phase boundaries; on a quota warning or interruption, preserve completed and partial work immediately and record the affected stage before switching an authorized builder or restarting a review. A usage cutoff must never leave the only copy of completed work in a running session.
- Keep the accepted spec, current base/branch, review findings and decisions, exact reviewed snapshot identity, and verification results in the durable handoff. Temporary directories may hold disposable test data and caches; copy needed evidence to durable storage before cleanup.
- Before deleting a worktree, dropping a stash, pruning worktree metadata, or cleaning task artifacts, verify that the latest implementation and needed evidence exist in a separate recoverable checkpoint. Preserve backups until their replacement is verified.
- After an interruption or missing-directory incident, inspect Git history, stashes, worktree metadata and durable records before rebuilding. Preserve recovery evidence, disclose what was lost, and rerun checks invalidated by reconstruction. Earlier passing tests or reviews do not attest reconstructed code.

## Opus-only building and subscription usage pauses

- Use Claude Opus through subscription authentication for all implementation and code fixes. Do not automatically fall back to Sol, Astra, or another builder when Claude usage is high or exhausted. This user preference supersedes skill fallback instructions. Fable remains the requested reviewer.
- Read authoritative Claude subscription utilization and reset times (the interactive Claude CLI `/usage` display is verified to expose them). Check before each build/review, at phase boundaries, and at least once a minute during active work. Monitor both the session limit and every applicable weekly/model limit; session token counts and dollar-cost estimates are not subscription percentages.
- At 90% or greater utilization in any applicable window, stop the active worker promptly, verify it has stopped, preserve all task-owned partial/untracked edits in a verified durable checkpoint, push the task branch backup, and record utilization plus the reported reset time. Do not wait for a hard cutoff. If a current utilization reading cannot be obtained, pause and record that uncertainty rather than assume capacity.
- On a new usage pause, schedule a task wake/check two hours later. If the blocking limit has not reset, re-schedule the check one hour later and repeat hourly. Record the provider's stated reset time and check it when due if earlier; use one existing task automation rather than duplicate timers. A clock reaching the reset time alone does not prove capacity has reset. Resume only after fresh usage evidence confirms all relevant limits allow work below 90%, with Opus as builder.
- Preserve an explicitly agreed next-resume appointment (currently September 8, 2026 at 5:31 p.m. America/New_York). At that wake, check actual limits first; if still blocked, recheck one hour later. Fable reviews changes since its last verified snapshot when capacity permits. Use app automations for waits; do not hold a shell asleep for hours. Never enable API billing, paid usage credits, or buy/redeem resets to bypass this policy.
