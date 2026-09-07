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
- Keep the accepted spec, current base/branch, review findings and decisions, exact reviewed snapshot identity, and verification results in the durable handoff. Temporary directories may hold disposable test data and caches; copy needed evidence to durable storage before cleanup.
- Before deleting a worktree, dropping a stash, pruning worktree metadata, or cleaning task artifacts, verify that the latest implementation and needed evidence exist in a separate recoverable checkpoint. Preserve backups until their replacement is verified.
- After an interruption or missing-directory incident, inspect Git history, stashes, worktree metadata and durable records before rebuilding. Preserve recovery evidence, disclose what was lost, and rerun checks invalidated by reconstruction. Earlier passing tests or reviews do not attest reconstructed code.
