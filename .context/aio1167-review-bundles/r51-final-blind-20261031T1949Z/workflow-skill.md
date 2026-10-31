---
name: astra-spec-claude-build
description: Build requested features with Astra specification, dynamically selected Sonnet 5 or Opus 5 implementation, Fable 5.1 reviews and fresh Astra final review, then publish a PR. Use for this multi-model build workflow.
---

# Astra Spec Claude Build

Carry the request through specification, implementation, independent reviews, verification and a published PR. A build invocation authorizes scoped commits, task-branch pushes and a PR, not merging or deployment. Editing this skill alone does not start that workflow. Explicit user model choices override automatic routing.

Invoking this workflow authorizes sending the necessary task-scoped request, specification, source excerpts, committed and working-tree diff, changed-file list, sanitized Git status and relevant verification evidence to the assigned Claude builder/reviewer through the subscription-authenticated CLI. This includes private repository material needed for the assigned scope; do not ask for another confirmation for these prescribed reviews. Minimize the payload and exclude credentials, private member/customer data, unrelated files and unrelated handoff/history. If necessary material falls outside this authorization, obtain specific authorization for that material rather than omitting required coverage or expanding recipients.

Use existing user authorization in the normal tool approval mechanism. If automatic approval review rejects a dispatch, present the explicit workflow invocation, authorized payload and sanitized scope through that mechanism; never bypass the rejection or claim a skill changes tool permissions. Ask the user only if the action remains blocked after presenting that evidence or materially exceeds the authorized scope, and report the actual rejection and its stated reason. Editing this skill does not itself start a build or send review material.

## Model assignments

| Role | Model | Reasoning |
| --- | --- | --- |
| Workflow coordinator | GPT-5.6 Terra (`gpt-5.6-terra`) for bounded work; GPT-5.6 Sol (`gpt-5.6-sol`) for uncertain or high-consequence coordination | low by default; medium when task evidence requires it |
| Spec author and decision owner | GPT-6 Astra (`gpt-6-astra`) | medium |
| Spec and first code reviewer | Claude Fable 5.1 (`claude-fable-5-1`), subscription CLI | provider default |
| Bounded implementation | Sonnet 5 (`claude-sonnet-5`) | high |
| Complex implementation | Opus 5 (`claude-opus-5`) | high |
| Final independent reviewer | GPT-6 Astra (`gpt-6-astra`), fresh context | high |

Astra owns specification and review adjudication; the selected builder applies implementation and accepted fixes. The coordinator manages stage transitions, workers, checks, preservation and publication without retaining specification work in its own context. Delegate specification/adjudication to Astra at the exact model and effort above. Never simulate another model's role by labeling your own output.

## Usage discipline

Treat model calls as work units, not as a monitoring loop. The normal path is one Astra specification, one Fable spec review, one builder session, one Fable code review and one fresh Astra final review. Start an additional model run only when a concrete finding, failed acceptance criterion, material base change or interrupted session invalidates an earlier result; record that trigger in the handoff. Repeated related failures trigger the architectural root-cause check; do not spend repeated model calls patching symptoms before that check is complete. Do not create parallel agents for the same role, keep completed agents alive for status, or ask a model to restate evidence already preserved in an artifact.

Exactly **one active coordinator** owns supervision, checks, review routing and the current-state handoff. Start with GPT-5.6 Terra **LOW**, use Terra **MEDIUM** for dependent slices, and escalate to the designated stronger coordinator, GPT-5.6 Sol **MEDIUM**, for concrete consequential uncertainty or repeated loss of continuity, overlooked dependencies or corrective steering. Record the observed failures, competing evidence, acceptance impact and bounded escalation decision; repeatedly forcing the lighter model through rework is not efficiency. A single routine test failure does not justify escalation. Return to Terra once the issue is settled and continuity is reliable. Architectural/shared-contract/security uncertainty goes to Astra **high**; material spec changes return to the assigned author and affected gate. Builder and independent-review assignments stay fixed; Astra must not become the persistent coordinator.

Dispatching a worker, preparing a prompt, reporting a failed check or receiving a review verdict is not completion. Keep the coordinating turn active: supervise through the terminal result or a safe timed preservation point, then advance the next authorized step. Repair failed checks and reconcile findings rather than stopping at intermediate milestones. Stop only when the requested outcome is complete, the user requests a pause, or a concrete blocker prevents further authorized progress. Before stopping, durably preserve worker identities/state, task-owned partial work, unresolved evidence, the blocker and the exact next action under the checkpoint and quota rules. A preserved interruption is not a completed slice.

A parent chat receives milestone summaries and handles explicitly assigned actions only; it must not duplicate supervision, artifact reads, checks or handoff maintenance. Transfer ownership explicitly before another context coordinates, and verify that only the successor remains active. Keep the builder session and sole source writer intact; transferring coordination does not restart the builder or authorize a second writer.

Use foreground scripts and event-driven waits for routine worker monitoring, terminal-result capture, checkpoint deadlines, checks and independent remote-revision verification. Scripts retain evidence and emit compact state changes; models intervene at meaningful milestones, failures, decisions, deadlines and quota thresholds. Avoid model polling and repeated unchanged narration. Scripts honor normal approvals and may not expand external-action authorization.

Maintain **one compact canonical current-state handoff** in durable permitted storage outside committed source: accepted requirements/spec hash and acceptance status; exact base/local/reviewed/remote revisions and dependency fingerprints; active worker identities, actual models and states; unresolved findings/decisions; evidence links and inspected scope; exact next action; usage/reset evidence; checkpoint deadline. Load this concise state and relevant evidence, not the accumulated archive. Archive history separately and load it only for a relevant decision or invalidated evidence. When historical material dominates the useful working context, transfer coordination to fresh context at a coherent phase boundary using this record, verify live state and retire the outgoing coordinator. Preserve accepted requirements, unresolved findings and active worker identities; do not reconstruct unrelated history or discard valid evidence.

Measure efficiency per **completed, verified slice**, alongside acceptance and review coverage, reopened defects and rework. Record available cached input, uncached input and output separately from account-wide quota/reset data; do not double-count cached input included in a reported input total. Mark incomplete slices and unavailable measurements explicitly. Tokens per hour alone establish neither quality nor cost savings nor causal improvement. Preserve quota thresholds, authentication, authorization and checkpoint protections; never promise unmeasured savings.

Concise reporting follows sufficient analysis; it does not replace it. Do not impose arbitrary token or output caps on builders/reviewers, lower required reasoning effort, omit necessary context or accept incomplete coverage to meet a usage target. Inspect affected callers, privacy boundaries, shared contracts and retry/recovery behavior sufficiently, then summarize findings. Scale specifications and meaningful tests to risk while preserving every required role and final check. Reuse verified evidence only when unchanged scope and dependencies justify it; repeat checks/reviews for changes, failures or unresolved evidence, not merely to narrate progress.

## Select a builder for each coherent slice

Assess uncertainty, interacting systems, consequences of error and available verification—not just file count or whether the work is called a test fix. Record the selected exact model, effort, reason and escalation trigger in the handoff before dispatch.

| Task evidence | Builder |
| --- | --- |
| Accepted design, established local pattern, bounded change and clear checks: ordinary feature wiring, straightforward bug with known cause, mechanical refactor, docs or fixture repair | Sonnet 5 |
| Uncertain root cause; cross-owner state changes; concurrency, retries or transaction semantics; privacy/consent/data-loss risks; behavioral merge conflicts; broad refactoring or long autonomous investigation | Opus 5 |
| Mixed feature | Opus 5 for the hard boundary, then Sonnet 5 for independent well-specified slices after the decision is settled |

Use Opus 5 when risk or complexity remains unclear. Start bounded work with Sonnet 5; escalate if inspection reveals coupled invariants or if a meaningful attempted correction still fails the same acceptance criterion. Do not spend repeated cheaper-model turns circling an unresolved correctness problem. A test failure alone is not proof of a model limitation: distinguish environment, fixture, permission and implementation failures. Return to Sonnet 5 at a checkpoint when uncertainty is resolved and remaining work is bounded. Retain the assigned high implementation effort; usage targets do not justify lowering required effort, and maximum effort is not an automatic default. Evaluate outcomes with the real task's tests and independent reviews.

This routing applies Anthropic's guidance to this repository: Sonnet for everyday coding balancing speed and capability, Opus for complex agentic coding and systems work; benchmark actual tasks before changing the balance. The concrete risk examples above are local policy, not vendor guarantees. Sources checked September 11, 2026: [Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model), [Models overview](https://platform.claude.com/docs/en/models/overview). Recheck official guidance if model availability or task evidence changes. This skill selects only Sonnet 5 or Opus 5 for building; Fable stays a reviewer.

## Ownership before implementation

Before assigning a slice, inspect active worktrees, branch diffs and relevant open PRs. Record one owner per shared behavior, schema/migration and implementation area, together with the branch, current checkpoint and integration order. Coordinate overlapping work with its existing agent when authorized; if ownership cannot be established, hold the overlapping slice and continue independent work. Reuse existing fixes instead of building a second implementation. Recheck ownership on scope changes and handoffs, not only before merging. Separate worktrees do not establish separate ownership. Reserve unique migration numbers across active branches.

## Supervision, authentication and preservation

- All Anthropic implementation, reviews and probes use signed-in Claude subscription access: verify `claude auth status`, remove inherited `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` overrides and never load application credentials or extract subscription tokens. Codex builders use the configured signed-in Codex account; inspect its login status using installed tooling.
- Keep safe worker activity streaming directly to a visible local panel or terminal, without a model call per update. Locate the repository's existing stream helper (for example `scripts/opus_watch.py` or `scripts/opus-activity-panel.py`) and inspect support for the selected model before using it. If absent or incompatible, use a supported local follower and separate verified quota supervision; never claim an unavailable helper works. Show public activity, not internal reasoning, raw tool arguments, credentials or private data. Attach without restarting the current worker, and verify a subsequent event; a queued panel is not proof of live display.
- Active supervision means intervention at milestones, errors, completion, decisions, checkpoint deadlines and quota thresholds. Prefer event-driven signals or bounded blocking waits; keep unavoidable polling local and do not repeatedly read unchanged logs. Explain that live display is separate from actual model monitoring.
- Stop at 90% of any applicable current quota window. For Claude use supported CLI rate-limit events; for Codex use the account usage tool or supported CLI telemetry. Token totals, dollar estimates and successful authentication are not quota percentages. Verify fresh capacity before dispatch; unknown/stale telemetry or a stop latch requires verification first. Do not switch models to evade a shared quota stop. Preserve a safely paused worker's identity/context, and verify capacity plus identity before explicit resumption. Never buy credits or consume resets without authorization. Schedule reset checks only under the user's existing scheduling instructions; a clock reset alone is not proof of capacity.
- Use persistent project storage, never the sole copy in OS temporary folders. Checkpoint task-owned source and tests after each meaningful slice, locally at least every 10–15 minutes of active editing and before major phase transitions; push task-branch checkpoints at least every 30 minutes and before long checks, reviews or handoffs, following stricter project rules. Inspect explicit staged paths, exclude private data, push authorized task-branch backups and verify remote SHA. Record exact revisions and remaining work durably.
- One writer at a time for each owned area. Before a model switch, wait for the outgoing writer and child processes to be idle/stopped, preserve partial edits and a checkpoint, then hand off the accepted spec, current diff, tests and pending findings. Do not reset work or restart the feature. Announce the chosen model and brief reason once per switch. Keep reviewers independent; switching builders never waives tests or review gates.

### Claude CLI execution notes

These are operational lessons from the Hermes 2nd Brain workflow; verify the installed CLI's help and actual provider metadata because flags and model availability can change.

- Run `claude auth status` and the authoritative subscription-usage check in the same approved full-user execution context that will launch Claude. A restricted shell may not see the macOS Keychain login and can report `loggedIn: false` even when the user's interactive subscription is available; verify through the normal permission path before treating that as sign-out. Never use `--bare`, copy OAuth tokens, or switch to API-key billing.
- For a Claude run affected by custom hooks, an MCP issue, a first run in a new execution context, or an unusually large prompt at risk of losing context, use one bounded no-tools preflight with `--safe-mode --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'`. Put the necessary task context in the prompt because safe mode disables project/user customizations and tools are unavailable. Continue only after substantive task-specific output. This is a diagnostic/context check, not a routine extra call for every run.
- For the actual run, use `--safe-mode --strict-mcp-config --mcp-config '{"mcpServers":{}}'` unless the assigned role needs a documented MCP server or customization. Explicitly supply repository instructions that safe mode would otherwise hide, and allow only the tools needed for that role. For authorized edits use the normal edit permission mode; `dontAsk` can deny edits and is not a substitute for approval. Do not bypass a permission denial.
- Keep long builders in a resumable session and record its session ID. For non-interactive work, prefer Claude Code's `-p` mode with `--output-format stream-json --verbose`, prompt files/stdin, and separate stdout/stderr logs; resume the same session with `--resume <session-id>` after interruption instead of starting over. Do not set `--no-session-persistence` on a builder: it disables recovery. Use it only for fresh preflights and independent reviews that do not need resumption. Preserve stage state and exact evidence in the canonical handoff so a resumed workflow re-enters at the first incomplete or invalidated stage. Expose only safe event summaries such as tool names, relevant file paths, elapsed time, and terminal status; never display reasoning or raw tool arguments.
- Resolve and verify the executable and version when the CLI is missing, the selected model is rejected, or output is unexpectedly incomplete. Inspect the terminal event and substantive final text before accepting success; do not loop on a quiet stream, hook failure, or empty result without new diagnostic evidence.

## Start with a Linear ticket

Before specification or implementation, read the repository instructions and establish the intended Linear team/project, then create a Linear ticket in **In Progress** describing the request, scope, and known constraints. Use the AIOS toolkit's bundled Linear CLI where available; locate its `scripts/linear.mjs` entrypoint from the installed toolkit and inspect its help. Do not invent an `aios linear` command, team, project, parent issue, or issue identifier. Read the available `aios-linear` skill when the repository routes Linear work through it. If the destination cannot be established from repository context or the user's request, ask for the missing destination.

If the user supplies an existing ticket, or this is a resumed task with a recorded ticket, read and reuse it instead of creating a duplicate. Record the returned issue identifier and URL in the handoff. Preserve any separate brain row key and the repository's rules for branch names and trailers; a Linear identifier is not a substitute for a brain row key. When starting work on a reused ticket, move it to **In Progress**. Verify the ticket and its In Progress state by reading it back before starting Stage 1. If a create request has an uncertain outcome, inspect Linear before retrying.

The bundled CLI supports `create "<title>" --desc <file> --state "In Progress"` and `get <IDENT> --full`. Confirm its current destination-selection behavior and resolve the intended team's In Progress workflow state before creating the issue. Use `set-state <IDENT> "In Progress"` for a reused ticket. Keep descriptions in files and use subprocess argument arrays or safe shell quoting. Use configured credentials without printing them. Creating this skill does not itself create a Linear ticket or start the build.

## Preparation and execution

1. Read repository instructions, inspect git status, and establish the target repository. All new work branches from current remote `staging` and opens PRs against `staging`, as required by `AGENTS.md`. Fetch the base and record its SHA. Use an isolated worktree on a `codex/` feature branch when the existing checkout has unrelated work. Preserve user changes. Avoid pulling main into an unrelated feature branch.
2. Check installed CLI help, authentication and exact model availability before dispatch. Verify the selected builder and `claude-fable-5-1` from actual provider output, not a generic alias. Never silently change a reviewer, version or model family. If a selected model is unavailable, use the other permitted builder only if it meets the slice requirements and has verified capacity; otherwise report the blocker. Authentication and permission errors are not reasons to switch models.
3. Keep a compact handoff directory outside the committed source tree, in a persistent project directory or persistent worktree, never as the only copy in an OS temporary directory. Record the request, base SHA, working directory, spec version, stage status, session identifiers, actual model identifiers, review findings, decisions, and verification results. Store the durable spec in the repository's usual spec location when appropriate. Keep temporary prompts and transcripts out of the PR.
4. Run writers sequentially against the implementation worktree. Run reviews against a stable snapshot and record the reviewed commit or diff fingerprint. Each worker receives the request, relevant repository instructions, necessary artifacts, and its bounded role. Workers must not recursively invoke this whole workflow or independently push, merge, deploy, or open PRs.

### Review bundle

Before each code review, the coordinator generates readable artifacts containing the full task diff, changed-file list, base SHA, implementation HEAD, and working-tree status. Include committed changes relative to the recorded base, staged and unstaged changes, and the contents of task-owned untracked files. Do not omit new files merely because `git diff` does not show them. Account for renamed, deleted, and binary files explicitly; provide suitable inspection evidence for binaries. Exclude credentials and unrelated user files.

Place the bundle in permitted storage accessible to the reviewer and pass its exact paths in the prompt. Fable's Read/Glob/Grep tools cannot generate a git diff themselves. Record a fingerprint covering the bundle and reviewed source contents; freeze writes until the review returns. A changed snapshot invalidates the affected review coverage.

### Resume interrupted work

On resume, read the handoff record and inspect the actual branch, working tree, worker status, commits, and any existing PR. Reconcile artifacts with completed operations before retrying. Continue an existing worker where suitable; never start a second writer while the first is still active. Resume from the earliest stage invalidated by changed requirements, code, or missing evidence. Preserve completed valid stages. If a commit, push, or PR request had an uncertain outcome, inspect remote state before repeating it. If temporary records are gone, reconstruct from available artifacts and explicitly repeat only the checks whose completion cannot be established.

Use available model-selectable delegation tools or the installed CLI. The following Codex pattern starts a new context and can read a task prompt from stdin:

```sh
codex exec --ephemeral -C "$worktree" -m gpt-6-astra -c 'model_reasoning_effort="medium"' -s read-only -o "$spec_output" - < "$spec_prompt"
```

Set `implementation_model` to the verified `claude-sonnet-5` or `claude-opus-5` for this slice. Use the Claude CLI in the worktree with subscription authentication and existing permission controls:

```sh
claude -p --model "$implementation_model" --effort high --output-format stream-json --verbose --permission-mode acceptEdits --tools 'Read,Glob,Grep,Edit,Write,Bash' < "$implementation_prompt"
```

Record the returned Claude session ID in the durable handoff. If interrupted, resume that same builder session and worktree with `claude -p --resume "$builder_session_id"` plus the required model, permission, and output options; do not create a replacement writer while the original session or child process may still be active.

Inspect the process result, reported model, permission denials, actual diff, and verification results. Handle any required command approvals through the normal permission controls; a denied operation is not completed work.

For the final Astra review use a new `codex exec --ephemeral` invocation with `high` reasoning and `read-only`; do not resume or fork the authoring conversation. Recheck options against installed CLI help when necessary.

For Fable reviews, use a new noninteractive invocation with the verified version-specific model identifier:

```sh
claude -p --model "$fable_51_model_id" --output-format json --no-session-persistence --permission-mode dontAsk --tools 'Read,Glob,Grep' < "$review_prompt"
```

Run it from the reviewed worktree. Restrict reviewers to reading and reporting. The coordinator can run requested diagnostic tests separately. Capture stdout and stderr, inspect exit status and reported model metadata where available, and verify a substantive review was returned. A permission denial, empty output, unavailable model, or failed process is not a clean review. Do not bypass sandbox or permission controls. Avoid inserting untrusted prompts into shell command strings; use prompt files or subprocess argument arrays.

## Architectural root-cause check

In AIOS, apply this check to the relevant parts of ingestion and connector reconciliation, task and work-event projection, durable jobs and scheduled publication, invitations and notifications, and access or visibility materialization. Trigger it when three or more defects, review findings, failing acceptance cases, or recovery anomalies involve the same workflow or state transition. Trigger it immediately for duplicate connector mutations, external deliveries, publications, invitations, or operational alerts; cancellation, access revocation, visibility or privacy, deletion, or data-loss behavior; uncertain queue, provider, connector, or external-side-effect outcomes; retry or recovery that can advance, clear, replace, or replay state; or competing writers or consumers of one durable record.

The decision owner records the source of truth for each material state; every writer, reader, queue producer, worker, retry and recovery path; ownership-transfer boundaries; idempotency keys and the relevant request, job, publication, ingestion-run, connector-sync, or work-event identity; and durable evidence. Record how accepted, blocked, failed, cancelled, revoked, deleted, superseded, and uncertain outcomes are represented across layers. Include a compact ownership map: transition, canonical owner, other writers or consumers, durable evidence, retry or recovery behavior, and unresolved ambiguity.

Require an architectural correction, rather than separate local patches, when multiple components can independently advance, clear, replace, or replay one state; success is inferred from a missing error or normal return rather than durable acceptance; retries lack identity distinguishing original intent from a later request, run, or publication; a delayed worker, connector sync, scheduled publication, or retry can undo a terminal action; or repeated fixes add layer-specific exceptions instead of clarifying one owner. The correction establishes an explicit ownership boundary, preserves compatible behavior unless the spec deliberately changes it, and tests normal execution, delayed work, retry, cancellation, revocation, deletion, or replacement, and uncertain external effects where relevant. If no shared cause exists, record why the existing ownership remains coherent; do not redesign speculatively.

## Stage 1: Astra specification

Astra at medium reasoning reads the relevant implementation, schemas, tests, and product documentation before writing the spec. Include:

- Intended user outcomes, scope, exclusions, and concrete acceptance scenarios.
- Current behavior and the proposed changes with relevant code references.
- Data ownership, sources of truth, invariants, and state transitions.
- Error recovery, retries, concurrency, privacy, and integration effects where relevant.
- Migration and rollout requirements, compatibility, and rollback where relevant.
- An implementation sequence and tests tied to observable requirements.
- When the architectural root-cause check is triggered, ownership and state-transition analysis, with its map and decision linked from the acceptance matrix or decision record.

Assign stable acceptance IDs such as AC-01. Maintain a small acceptance matrix mapping each requirement to its observable expected behavior. Preserve IDs through revisions; explicitly mark replaced requirements rather than silently changing their meaning.

Scale detail to the change. Make routine engineering choices directly. Surface unresolved product choices that materially affect behavior; continue independent analysis while awaiting necessary answers.

## Stage 2: Fable spec review and Astra revision

Give Fable 5.1 the user request, spec, and repository access. Ask it to audit feasibility, intended behavior, missing journeys, incorrect assumptions, unnecessary complexity, data consistency, proposed tests, unclear ownership, duplicate producers or consumers, missing durable outcome states, retry-identity gaps, and delayed-work reversals of terminal actions. Require concrete counterexamples and file references where applicable.

Astra evaluates each finding as accepted, rejected with evidence, or unresolved. Route applicable ownership findings through the architectural root-cause check, then revise the spec for accepted findings. Re-review with Fable when revisions change architecture, user behavior, migrations, or important acceptance criteria, or when the first review left substantive uncertainty. A wording-only change does not require another pass.

Default to at most three substantive review/revision rounds per stage. If material disagreement persists, summarize the exact decision needed and pause the dependent work rather than looping indefinitely or treating the review as passed.

Confirmed in-scope correctness, privacy, data-loss, security, and acceptance failures block completion. Missing required verification or a required model review also blocks a claim of completion. Cosmetic preferences and unrelated improvements are optional and should not restart review cycles. Investigate speculative concerns until they can be supported or rejected with evidence; model disagreement alone is not a blocker. At the round limit, escalate only a specific unresolved material issue and continue any independent work that remains valid.

### Attach the agreed spec to Linear

After Astra resolves the spec review and the spec satisfies any repository-required readiness gate, attach the exact agreed spec to the task's Linear ticket **before implementation**. Keep the durable spec in the repository and record its path and content hash in the handoff. Make the complete Markdown spec readable in Linear: append or update a clearly delimited `Accepted specification` section in the ticket description, preserving the original request and unrelated content. A local filesystem path alone is not an attachment. If using a native file attachment instead, verify that the uploaded document is accessible from the ticket.

With the bundled CLI, read/export the existing description, compose the merged description in a durable task file, then use the supported `set-desc <IDENT> <file>` and `verify-desc <IDENT> <file>` commands. Re-read immediately before writing to avoid overwriting intervening edits, and verify the saved spec by reading it back. Record the ticket URL and attached spec version/hash. If implementation later requires a material spec revision, repeat the affected review/readiness gate and refresh the ticket's accepted spec before resuming implementation. Missing Linear access or a failed attachment leaves this stage incomplete; report the concrete blocker.

## Stage 3: Implementation

Give the selected implementer the accepted spec, repository instructions, relevant code, and acceptance criteria. The selected implementer implements the scoped change and meaningful tests, runs the relevant checks, and reports deviations or unresolved issues. If implementation reveals a material flaw in the spec, return it to Astra for resolution and repeat the affected spec review before proceeding. A second related failure in one workflow is not another local patch: return it to Astra for the architectural root-cause check before expanding the fix.

The coordinator verifies the actual diff and test results. Passing tests alone does not demonstrate spec compliance.

The selected implementer fills the acceptance matrix with implementation file references and test names/results or appropriate manual evidence for every acceptance ID. Mark unmet or unverified criteria explicitly. Reviewers independently check the spec against implementation before comparing this matrix; the author's mapping is evidence to examine, not proof of coverage.

## Stage 4: Fable code review and Astra adjudication

Give a new Fable 5.1 session the accepted spec, base SHA, complete implementation diff, and surrounding code access. Request bugs, logical errors, architectural regressions, missing acceptance behavior, inadequate tests, and whether each affected transition has one canonical owner. Review callers and consumers beyond changed lines. Require severity, trigger, expected versus actual behavior, evidence, and a regression-test recommendation.

Astra validates findings against code and product intent. Reopen the architectural root-cause check when three related findings accumulate, or immediately for its high-risk triggers. Send accepted corrections to the selected implementer. Preserve a decision record for rejected findings with concrete reasons. Verify fixes and run affected tests. Obtain another Fable pass when corrections are substantial or its blocking concerns remain unresolved.

## Stage 5: Fresh Astra review

Start a completely new Astra context with high reasoning. Supply only the user request, accepted spec, repository instructions, base SHA, and current implementation snapshot. Do not seed it with earlier reviews, author explanations, adjudication records, or conversation history. Ask it to independently examine correctness, architecture, integration behavior, spec compliance, hidden duplicate ownership, implicit success inference, stale retry identity, and delayed-work reversals of terminal decisions in changed workflows.

After independent findings are returned, the coordinating Astra reconciles them with evidence and earlier decisions. The selected implementer implements accepted fixes and verifies them. Any substantive fix after this review requires a fresh focused Astra review of the affected behavior and its interactions. Record which final snapshot was reviewed; do not claim an earlier review covers later changes.

## Stage 6: Verify and publish

Confirm all required acceptance criteria are satisfied and substantive findings resolved. State whether the architectural root-cause check was triggered, its canonical-owner decision, and the tests covering delayed workers or connector sync, retry or recovery, cancellation, revocation, deletion, or replacement, and external-delivery uncertainty where relevant. Run repository-required checks and tests appropriate to the final diff. Report any checks that cannot run; do not describe them as passing. If a required review or correctness blocker remains, stop before publication unless the user explicitly requests a draft PR with those limitations.

Fetch the target branch again before publication and compare its current SHA with the recorded review base. Inspect intervening changes for overlapping code, callers, schemas, dependencies, and assumptions. Integrate relevant base changes using the repository's normal merge/rebase practice, preserving user work and avoiding force-pushes to shared branches. Have the selected implementer resolve implementation conflicts, with Astra deciding changes to behavior. Re-run affected checks and reviews for material changes. If the base advanced without affecting the feature, record the assessed SHA and reason integration was unnecessary. Record the final implementation commit and reviewed base in the handoff and PR; disclose if the remote moves again during publication.

Inspect the final diff, stage only the task's files, commit, and push the feature branch. Check for an existing PR for that branch and update it rather than creating a duplicate. Open a PR against the agreed base with the problem, resulting behavior, relevant design decisions, verification, and any migration requirements. Use a body file or structured API argument for multiline descriptions.

Finish with the Linear ticket and PR links, a concise account of the change, actual models used, review outcomes, test results, and remaining limitations. Leave merging and deployment to a separate user instruction.

## Stage 7: Close the Linear ticket after verified staging deployment

Keep the ticket **In Progress** while implementation, review, merge, or staging deployment is pending. After the feature's PR has been merged into `staging` and that exact merge/squash commit is verified as deployed to the staging environment, move the Linear ticket to **Done** with the bundled CLI's `set-state <IDENT> "Done"` command (resolve the team's actual Done workflow state first). Verify the PR's merged status and target branch using the hosting provider, confirm the commit is contained in remote `staging`, and verify the staging deployment identifies that commit or a descendant that includes it. A completed build, an open or merely closed PR, or a merge into `staging` before deployment verification does not satisfy this condition.

This closeout step does not authorize merging or deployment: retain the separate user instruction required for each. When both authorized operations complete, perform the ticket transition without another confirmation. On a resumed task, inspect the existing PR, staging deployment, and ticket before retrying. Read the ticket back to verify Done and report its URL and the merge and deployment evidence. If the state update fails, report that staging deployment completed but ticket closeout remains incomplete.
