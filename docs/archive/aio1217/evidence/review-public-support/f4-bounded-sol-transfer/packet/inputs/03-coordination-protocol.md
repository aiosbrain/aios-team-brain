# AIO-1217 resumable coordination protocol

This is the small operational handshake for the next sole coordinator. `CURRENT.json` is the canonical task state; archived `CURRENT` files are history only.

## Ownership and admission

- Lifecycle clarification (parent, 2026-10-05): “no-restart/no-duplicate” barred interrupting or restarting the then-live source worker during coordinator transfer. It is not a permanent ban on future implementation. The exact old Opus wrapper/child are now host-confirmed absent and its no-session-persistence session cannot resume. With its 132211ea partial source and backup preserved, one fresh subscription-authenticated Opus 5.5 HIGH continuation is authorized after a fresh no-tools capacity/auth admission proves all applicable provider windows below 90%. Do not restart the old session or create concurrent writers. Record the new identity before editing and retain the old interruption truth.

- The bounded GPT-5.6 Sol MEDIUM continuity repair is complete at remotely verified checkpoint `7e5867f7`. All earlier Terra contexts and all source/review workers are STOP. A fresh GPT-5.6 Terra MEDIUM becomes the sole coordinator only after reading `CURRENT.json`, this protocol, and the current shared skill.
- Preserve exactly one source writer. Never start or resume another writer until the prior wrapper has produced a successful terminal result, exited, and been reaped or independently proved absent in the approved host context. A hidden/inaccessible process or `sandboxPermissionError` is UNKNOWN, never STOP.
- The current writer record is `opus-next7-builder.interruption.json`: Opus 5.5 HIGH session `95b321d2-01fd-4e38-b6f0-d35c5b024c41`, wrapper PID `45650`, child PID `45678`. It was last verified live at `2026-10-05T10:08:04Z`; an approved exact-PID host probe at `10:12:10Z` found both absent, with no terminal result/status/final record. Treat it as STOP incomplete, preserve its sole-writer ownership and partial file, and do not restart or duplicate it.
- Keep the coordinating turn active through a terminal result and the next authorized action or a safe, durable preservation point. Dispatch, a failed check, or a review verdict is not completion.

## Parent-owned source launch and terminal handshake

0. Terra must not directly launch a source writer. At a coherent source boundary, Terra prepares the exact sanitized Opus prompt, allowed files, allowed tools and working directory in durable storage, then emits an explicit parent launch request. The parent root starts the Claude wrapper in its own persistent foreground unified-exec session, records the worker PID/model/session identity, owns all event-driven waits and the final reap, and returns the terminal record to Terra. Terra retains sole coordination of checks, reviews, findings and handoff. A launch receipt or session identifier alone is not terminal evidence and does not solve the prior early-return failure.

1. Supervise the foreground wrapper through its originating exec session using an event-driven wait/follower. Do not repeatedly ingest unchanged raw JSONL or private reasoning.
2. If exact host state is needed, probe the recorded wrapper/child PIDs through the normal approved host route. Do not suppress a permission error and then label the worker stopped.
3. Accept a Claude result only when all are true: wrapper process has returned; exit is `0`; a successful terminal `result` event exists; substantive final text exists; the reported model is `claude-opus-5-5`; and recorded permission denials are `0`. Inspect any denial before retrying.
4. After capture, inspect the actual diff and assigned-file boundary. The coordinator—not Claude—runs checks with `run_check.py`, including synthetic PG through the approved host route. Builder claims and terminal success are not test evidence.
5. If the result is incomplete, preserve partial task files first. Restart only after exact process-state verification and a durable handoff; never launch a duplicate merely because a status file is absent.

## Correct tools and payload boundary

- Claude implementation uses a parent-launched scoped foreground wrapper: subscription-authenticated Claude, both Anthropic key variables removed, safe/restricted configuration, HIGH effort, and only `Read,Glob,Grep,Edit,Write`. No Bash. Copy the minimum sanitized support artifacts into `review-public-support` before dispatch; do not grant the worker general handoff/history reads.
- Claude review uses the same wrapper with `--read` and only `Read,Glob,Grep`. Reviewers are fresh and read-only.
- The coordinator owns shell commands, tests, lint, Postgres lifecycle, Git checkpoints, remote verification, and permission handling. Use `run_check.py`; never let a worker substitute an unobserved check.
- A fresh Codex coordinator uses bundled runtime `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex` version `0.159.2`. The verified invocation uses `--approve-for-me` plus the additive accepted private-payload policy and `--add-dir` for this handoff. Do not combine `-s` with `--approve-for-me`; do not use the old Homebrew `0.154` binary or bypass permissions.
- The existing live wrapper was loaded before this record. Do not mutate its protocol or provider/auth configuration after launch.

## Checkpoints and coverage accounting

- During active editing, capture a verified local task-owned checkpoint every 10–15 minutes and push normally at least every 30 minutes, before long checks/reviews/transfers, and at meaningful milestones. Include untracked task files; exclude secrets, dependencies, and unrelated work.
- Run normal pre-push review/hooks, then independently read `git ls-remote` before resetting the checkpoint clock. If no changes exist, verify the remote already holds the checkpoint; do not make an empty commit. Never bypass a gate.
- Record each completed verified slice with exact revision, checks, reviewed scope, reopened issues, and rework. Keep provider `input_tokens` (uncached), cache-creation input, cache-read input, and output separate from subscription quota percentages/reset times. Do not double-count or make savings claims.
- Reuse unchanged evidence only with matching source/dependency fingerprints. Do not rerun full suites merely for narration; required final checks and fresh Opus/Astra/Sol reviews still apply at final readiness.

## Shared-owner and publication gates

- Direct human "yes go ahead" authorizes AIO-1217 ownership of the accepted-v6 narrow `lib/access/enforce.ts` visibility-error propagation fix; see `user-ownership-approval-20261005.json`. PR714 stays held and must later reconcile this narrow fix. Six visible-item lookup-error oracle legs remain required and unverified until actual regression evidence; content-isolation observations are not refusal compliance.
- No messages to PR owners or other chats without direct human authorization. No source change on that path until one owner and integration order are verified.
- Final readiness still requires execution evidence for the 95 protected actions, remaining scope connections, account/documentation coverage, full checks, fresh independent Opus 5.5 code review, fresh Astra HIGH final review, and fresh blind GPT-6.1 Sol HIGH final review.
- Publish only to a staging-targeted PR when every gate is satisfied. This workflow does not authorize main, production deployment, or a force/admin bypass.
