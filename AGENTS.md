<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Anthropic coding authentication

Never use an Anthropic API key for coding. Always use Claude through subscription-authenticated access, including delegated coding and builder fallbacks. If subscription access is unavailable or reaches a limit, do not switch to API-key billing; use an authorized alternative builder or report the blocker.

## Local Linear access

For AIOS Linear work, load `LINEAR_API_KEY` from `/Users/chetan/Projects/chetan-aios/.env` and use the installed AIOS toolkit’s `scripts/linear.mjs` CLI. Never print, copy into source, or commit the key or the `.env` file.

## Authorization within an agreed workflow

- Carry existing user authorization forward. Do not ask again for routine steps necessary to complete an agreed workflow, including creating or updating its Linear ticket and attaching the reviewed specification to that ticket. The user explicitly authorizes these task-related Linear writes, including the AIO-997 publisher specification discussed in this session.
- A requirement to complete a step before coding is a sequencing rule, not a requirement for another approval. Preserve existing ticket content and verify writes without adding a confirmation gate.
- If automatic approval review rejects an action, first present the existing authorization and relevant evidence through the normal approval mechanism. Do not bypass a rejection. Ask the user only if the action remains blocked or materially exceeds the authorized scope, and identify the actual source of that restriction rather than attributing it to the specification.
- This preference does not authorize secret disclosure, unrelated external sharing, new recipients, production releases, or bypassing tool permission controls.

## Branch destination for new work

- All new work targets `staging`, not `main`. Create task feature branches from the current remote `staging`, push checkpoints to those feature branches, and open PRs against `staging`. Do not push new work directly to `main` or open new-work PRs against `main`; this explicit user policy overrides an older branch-role configuration or workflow default. Merging and deployment still require separate authorization.

## Durable work and recovery checkpoints

- Never keep the only copy of implementation work, an active worktree, review findings, or verification records under `/tmp`, `/private/tmp`, `$TMPDIR`, or another automatically cleaned directory. Use a durable, ignored directory inside the repository (for example, `.context/<task>-worktree` and `.context/<task>-handoff`) or an approved persistent workspace. Confirm the directory is ignored before placing local artifacts there.
- Before a long review or test run, a model/builder handoff, a pull/rebase, or another major phase transition, create a recoverable local checkpoint of all task-owned changes, including untracked files. Use a scoped local WIP commit, or a retained stash/backup whose successful capture is verified. Do not checkpoint secrets, generated dependencies, or unrelated user changes. Record the checkpoint commit/object ID in the durable handoff; never rely on uncommitted files alone for hours of work.
- During active editing, create and verify a checkpoint at least every 10–15 minutes, in addition to the phase-transition checkpoints above. Check worker status and available usage at major phase boundaries; on a quota warning or interruption, preserve completed and partial work immediately and record the affected stage before switching an authorized builder or restarting a review. A usage cutoff must never leave the only copy of completed work in a running session.
- During active work with new task-owned changes, push checkpointed work to the task branch on the authorized repository remote at least every 30 minutes and before major handoffs, even while the implementation or PR is unfinished. Commit task-owned partial and untracked work before pushing; a local stash or ignored directory alone is not a remote backup. Include sanitized recovery notes and needed evidence in the backed-up checkpoint so work can resume after machine or disk loss, excluding secrets, generated dependencies and unrelated user changes. Verify the remote branch contains the checkpoint commit and record its ID and push time in the durable handoff. If a push is blocked or fails, preserve the verified local checkpoint, record and report the missing remote backup, and retry through the normal permission/review controls; never bypass a push gate or claim an unverified push succeeded. These backups do not authorize merging or production deployment.
- Keep the accepted spec, current base/branch, review findings and decisions, exact reviewed snapshot identity, and verification results in the durable handoff. Temporary directories may hold disposable test data and caches; copy needed evidence to durable storage before cleanup.
- Before deleting a worktree, dropping a stash, pruning worktree metadata, or cleaning task artifacts, verify that the latest implementation and needed evidence exist in a separate recoverable checkpoint. Preserve backups until their replacement is verified.
- After an interruption or missing-directory incident, inspect Git history, stashes, worktree metadata and durable records before rebuilding. Preserve recovery evidence, disclose what was lost, and rerun checks invalidated by reconstruction. Earlier passing tests or reviews do not attest reconstructed code.

## Subscription usage pauses

- Before dispatch, verify fresh capacity and worker identity as required by the selected skill. Unknown/stale admission telemetry or a stop latch requires verification first. The unavailable-readout exception below applies to an already-active worker, not permission to start a new run.
- Read authoritative Claude subscription utilization and reset times (the interactive Claude CLI `/usage` display is verified to expose them). Check before each build/review, at phase boundaries, and every 20 minutes during active work. Monitor both the session limit and every applicable weekly/model limit; session token counts and dollar-cost estimates are not subscription percentages.
- At 90% or greater utilization in any applicable window, stop the active worker promptly, verify it has stopped, preserve all task-owned partial/untracked edits in a verified durable checkpoint, push the task branch backup, and record utilization plus the reported reset time. Do not wait for a hard cutoff. If a current utilization reading cannot be obtained, keep the already-active subscription-authenticated worker running, record the unavailable reading and last known utilization, and retry monitoring without treating missing telemetry as exhaustion. Do not pause solely because the usage display is unavailable or rate-limited. A confirmed reading at or above 90% or an actual provider usage-limit refusal still requires a pause.
- On a new usage pause, schedule a task wake/check one hour later. If the blocking limit has not reset, re-schedule the check one hour later and repeat hourly. Record the provider's stated reset time and check it when due if earlier; use one existing task automation rather than duplicate timers. A clock reaching the reset time alone does not prove capacity has reset. After a confirmed threshold or provider-limit pause, seek fresh usage evidence below 90% before resuming the selected worker; an unavailable readout alone does not establish a continuing block. Honor the user’s current capacity report and authorization to resume, and retain any actual provider refusal as a blocker.
- Preserve an explicitly agreed next-resume appointment (currently September 8, 2026 at 5:31 p.m. America/New_York). At that wake, check actual limits first; if still blocked, recheck one hour later. Fable reviews changes since its last verified snapshot when capacity permits. Use app automations for waits; do not hold a shell asleep for hours. Never enable API billing, paid usage credits, or buy/redeem resets to bypass this policy.

## Build workflows and model selection

- Use [Astra Spec Claude Build](.agents/skills/astra-spec-claude-build/SKILL.md) for Claude implementation and [Astra Spec Codex Build](.agents/skills/astra-spec-codex-build/SKILL.md) for Codex implementation. These replace the former Astra Spec Opus Build and Astra Build / Astra Spec Sol Build names in this repository.
- Select the builder per coherent slice: Sonnet 5 or GPT-5.6 Terra for well-defined, bounded work; Opus 5 or GPT-5.6 Sol for uncertain, cross-system or high-consequence implementation. Follow the selected skill's escalation criteria and record the actual model and reason. An explicit user model choice takes precedence. Do not switch provider families or evade a shared quota stop automatically.
- Astra retains specification/adjudication ownership; Fable 5.1 retains the required spec/code reviews; final Astra review uses a fresh context. A cheaper builder does not reduce acceptance, testing or review requirements.
- For workflow coordination, use GPT-5.6 Terra at low reasoning when requirements and checks are established, Terra at medium when reconciling dependent slices, and GPT-5.6 Sol at medium when coordination itself requires uncertain cross-system or high-consequence reasoning. Astra must not remain the persistent coordinator merely because it owns specification or adjudication: delegate those bounded roles to Astra at the required effort, then return execution coordination to the selected coordinator. Preserve the selected Claude or Codex builder as the sole implementation writer.
- Before switching builders, wait for the previous writer and child processes to be idle/stopped, checkpoint and remotely back up authorized changes, and preserve a durable handoff. Attach the live display and quota guard to the selected worker without restarting work just for visibility. Apply the existing 90% stop and subscription-only Anthropic authentication rules to every applicable run.

## Coordinate ownership across worktrees

- Before implementation, and whenever scope changes, inspect active worktrees, their current diffs and relevant PRs for overlapping behavior, shared owners and migrations. Separate branches do not make concurrent changes independent.
- Establish and record one implementation owner per shared behavior or schema area, its branch/checkpoint, dependent work and integration order. Coordinate with the existing agent when authorized. Do not treat a sent message as agreement: verify the ownership decision before assigning overlapping work. If it remains unresolved, hold that slice and continue independent work.
- Reuse the owning branch's accepted fixes rather than implementing parallel versions. A model handoff transfers ownership; it does not create an additional writer. Preserve each branch's test obligations during integration and do not resolve behavioral conflicts by selecting an entire file from one side.
- Check migration-number reservations across active branches before adding a migration, then recheck against the target branch before publication. Detect both content conflicts and incompatible state/queue/data contracts; a clean Git merge alone is not compatibility evidence.

## Live worker visibility with minimal monitoring overhead

- Stream safe builder activity (Opus, Sonnet, Sol or Terra) through a local script into a visible Codex panel or terminal. The display must update without a Codex model call for each event. Prefer the task's local activity panel (`scripts/opus-activity-panel.py`) or an equivalent local terminal follower.
- Active supervision means timely intervention at meaningful milestones, errors, completion, decisions requiring judgment, checkpoint deadlines and quota thresholds. It does not mean constant narration, repeated log reads or scheduled model calls merely to demonstrate activity.
- Use event-driven completion/error signals or blocking waits where supported. Keep unavoidable polling local and lightweight; do not feed unchanged logs back into Codex. Clearly distinguish a live display from model monitoring and disclose any UI limitation.
- Attach the display to the existing worker's persisted stream/status without restarting it. Show tool names, relevant file paths and status; exclude internal reasoning, raw tool arguments, credentials and private member content. A finished run must be labeled finished rather than presented as live work.
- Preserve subscription-only authentication, automatic stopping at 90% in any applicable quota window, single-writer operation, the stricter local checkpoint cadence above, verified remote backups, testing and required reviews. A display is not a substitute for these controls.
- Scheduled wakes remain available for genuine interruptions, recovery and quota pauses, not as the mechanism for streaming activity. If Codex cannot host an automatically updating stream, use the lowest-overhead supported local alternative and explain the limitation.

- Keep the coordinating Codex turn active during authorized work; event-driven supervision does not mean ending the turn while a worker is active.
