---
name: astra-spec-codex-build
description: Build requested features with Astra specification, dynamically selected GPT-5.6 Terra or GPT-5.6 Sol implementation, Fable 5.1 reviews and fresh Astra final review, then publish a PR. Use for this multi-model build workflow.
---

# Astra Spec Codex Build

Carry the request through specification, implementation, independent reviews, verification and a published PR. A build invocation authorizes scoped commits, task-branch pushes and a PR, not merging or deployment. Editing this skill alone does not start that workflow. Explicit user model choices override automatic routing.

## Model assignments

| Role | Model | Reasoning |
| --- | --- | --- |
| Workflow coordinator | GPT-5.6 Terra (`gpt-5.6-terra`) for bounded work; GPT-5.6 Sol (`gpt-5.6-sol`) for uncertain or high-consequence coordination | low by default; medium when task evidence requires it |
| Spec author and decision owner | GPT-6 Astra (`gpt-6-astra`) | medium |
| Spec and first code reviewer | Claude Fable 5.1 (`claude-fable-5-1`), subscription CLI | provider default |
| Bounded implementation | GPT-5.6 Terra (`gpt-5.6-terra`) | high |
| Complex implementation | GPT-5.6 Sol (`gpt-5.6-sol`) | high |
| Final independent reviewer | GPT-6 Astra (`gpt-6-astra`), fresh context | high |

Astra owns specification and review adjudication; the selected builder applies implementation and accepted fixes. The coordinator manages stage transitions, workers, checks, preservation and publication without retaining specification work in its own context. Delegate specification/adjudication to Astra at the exact model and effort above. Never simulate another model's role by labeling your own output.

## Usage discipline

Treat model calls as work units, not as a monitoring loop. The normal path is one Astra specification, one Fable spec review, one builder session, one Fable code review and one fresh Astra final review. Start an additional model run only when a concrete finding, failed acceptance criterion, material base change or interrupted session invalidates an earlier result; record that trigger in the handoff. Do not create parallel agents for the same role, keep completed agents alive for status, or ask a model to restate evidence already preserved in an artifact.

Use GPT-5.6 Terra at low reasoning for routine coordination with accepted requirements and clear checks. Increase Terra to medium when coordination must reconcile several dependent slices. Use GPT-5.6 Sol at medium for uncertain cross-system integration, consequential conflict resolution or recovery where the coordinator itself must reason about coupled invariants. Return to Terra after the decision is settled. Do not use Astra as the persistent root coordinator merely because Astra authors the specification or adjudicates findings.

Keep stage contexts narrow. Give each worker the accepted spec, current snapshot and only the repository material needed for its role. Prefer compact durable handoffs over conversation replay. Start fresh reviewer contexts as already required, and start a fresh coordinator task for a new coherent slice instead of carrying an unrelated build history forward.

Supervise through process state, exit status, filesystem changes and event-driven waits. Stream activity locally without sending each update through a model. Batch independent read-only inspections and related checks. Avoid repeated unchanged status reads and fragmented command calls made only to narrate progress. When an approval is required, prepare the exact scoped action first and request a reusable narrow command prefix when appropriate; do not generate repeated approval-review traffic for equivalent commands.

Scale specifications and verification to risk. A bounded change still receives all required roles, but its spec, acceptance matrix and test set should remain concise. One successful relevant check is enough unless changed code, a review finding or unresolved evidence requires another run. Do not broaden tests, reviews or research after the acceptance criteria are demonstrated.

## Select a builder for each coherent slice

Assess uncertainty, interacting systems, consequences of error and available verification—not just file count or whether the work is called a test fix. Record the selected exact model, effort, reason and escalation trigger in the handoff before dispatch.

| Task evidence | Builder |
| --- | --- |
| Accepted design, established local pattern, bounded change and clear checks: ordinary feature wiring, straightforward bug with known cause, mechanical refactor, docs or fixture repair | GPT-5.6 Terra |
| Uncertain root cause; cross-owner state changes; concurrency, retries or transaction semantics; privacy/consent/data-loss risks; behavioral merge conflicts; broad refactoring or long autonomous investigation | GPT-5.6 Sol |
| Mixed feature | GPT-5.6 Sol for the hard boundary, then GPT-5.6 Terra for independent well-specified slices after the decision is settled |

Use GPT-5.6 Sol when risk or complexity remains unclear. Start bounded work with GPT-5.6 Terra; escalate if inspection reveals coupled invariants or if a meaningful attempted correction still fails the same acceptance criterion. Do not spend repeated cheaper-model turns circling an unresolved correctness problem. A test failure alone is not proof of a model limitation: distinguish environment, fixture, permission and implementation failures. Return to GPT-5.6 Terra at a checkpoint when uncertainty is resolved and remaining work is bounded. Keep high effort initially; adjust only for measured task evidence and supported settings, never automatically use maximum effort. Evaluate outcomes with the real task's tests and independent reviews.

This is an analogous local routing policy, not an assertion that Terra is equivalent to Sonnet or Sol to Opus. OpenAI describes Terra as balanced for everyday work and Sol as its stronger GPT-5.6 model for demanding coding/reasoning. Source checked September 11, 2026: [GPT-5.6 introduction](https://openai.com/index/gpt-5-6/). Recheck official guidance and installed model availability when needed. This skill selects only Sol or Terra for building; it does not silently fall back to Claude when a quota is exhausted. Fable's subscription reviews remain required.

## Ownership before implementation

Before assigning a slice, inspect active worktrees, branch diffs and relevant open PRs. Record one owner per shared behavior, schema/migration and implementation area, together with the branch, current checkpoint and integration order. Coordinate overlapping work with its existing agent when authorized; if ownership cannot be established, hold the overlapping slice and continue independent work. Reuse existing fixes instead of building a second implementation. Recheck ownership on scope changes and handoffs, not only before merging. Separate worktrees do not establish separate ownership. Reserve unique migration numbers across active branches.

## Supervision, authentication and preservation

- All Anthropic implementation, reviews and probes use signed-in Claude subscription access: verify `claude auth status`, remove inherited `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` overrides and never load application credentials or extract subscription tokens. Codex builders use the configured signed-in Codex account; inspect its login status using installed tooling.
- Keep safe worker activity streaming directly to a visible local panel or terminal, without a model call per update. Locate the repository's existing stream helper (for example `scripts/opus_watch.py` or `scripts/opus-activity-panel.py`) and inspect support for the selected model before using it. If absent or incompatible, use a supported local follower and separate verified quota supervision; never claim an unavailable helper works. Show public activity, not internal reasoning, raw tool arguments, credentials or private data. Attach without restarting the current worker, and verify a subsequent event; a queued panel is not proof of live display.
- Active supervision means intervention at milestones, errors, completion, decisions, checkpoint deadlines and quota thresholds. Prefer event-driven signals or bounded blocking waits; keep unavoidable polling local and do not repeatedly read unchanged logs. Explain that live display is separate from actual model monitoring.
- Stop at 90% of any applicable current quota window. For Claude use supported CLI rate-limit events; for Codex use the account usage tool or supported CLI telemetry. Token totals, dollar estimates and successful authentication are not quota percentages. Verify fresh capacity before dispatch; unknown/stale telemetry or a stop latch requires verification first. Do not switch models to evade a shared quota stop. Preserve a safely paused worker's identity/context, and verify capacity plus identity before explicit resumption. Never buy credits or consume resets without authorization. Schedule reset checks only under the user's existing scheduling instructions; a clock reset alone is not proof of capacity.
- Use persistent project storage, never the sole copy in OS temporary folders. Checkpoint task-owned source and tests after each meaningful slice, at least every 30 minutes of editing, and before long checks, reviews or handoffs. Inspect explicit staged paths, exclude private data, push authorized task-branch backups and verify remote SHA. Record exact revisions and remaining work durably.
- One writer at a time for each owned area. Before a model switch, wait for the outgoing writer and child processes to be idle/stopped, preserve partial edits and a checkpoint, then hand off the accepted spec, current diff, tests and pending findings. Do not reset work or restart the feature. Announce the chosen model and brief reason once per switch. Keep reviewers independent; switching builders never waives tests or review gates.

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

Set `implementation_model` to the verified `gpt-5.6-terra` or `gpt-5.6-sol` for this slice. Use the Codex CLI with the current account and existing permission controls:

```sh
codex exec --ephemeral -C "$worktree" -m "$implementation_model" -c 'model_reasoning_effort="high"' -s workspace-write --json -o "$implementation_output" - < "$implementation_prompt"
```

Inspect the process result, reported model, permission denials, actual diff, and verification results. Handle any required command approvals through the normal permission controls; a denied operation is not completed work.

For the final Astra review use a new `codex exec --ephemeral` invocation with `high` reasoning and `read-only`; do not resume or fork the authoring conversation. Recheck options against installed CLI help when necessary.

For Fable reviews, use a new noninteractive invocation with the verified version-specific model identifier:

```sh
claude -p --model "$fable_51_model_id" --output-format json --no-session-persistence --permission-mode dontAsk --tools 'Read,Glob,Grep' < "$review_prompt"
```

Run it from the reviewed worktree. Restrict reviewers to reading and reporting. The coordinator can run requested diagnostic tests separately. Capture stdout and stderr, inspect exit status and reported model metadata where available, and verify a substantive review was returned. A permission denial, empty output, unavailable model, or failed process is not a clean review. Do not bypass sandbox or permission controls. Avoid inserting untrusted prompts into shell command strings; use prompt files or subprocess argument arrays.

## Stage 1: Astra specification

Astra at medium reasoning reads the relevant implementation, schemas, tests, and product documentation before writing the spec. Include:

- Intended user outcomes, scope, exclusions, and concrete acceptance scenarios.
- Current behavior and the proposed changes with relevant code references.
- Data ownership, sources of truth, invariants, and state transitions.
- Error recovery, retries, concurrency, privacy, and integration effects where relevant.
- Migration and rollout requirements, compatibility, and rollback where relevant.
- An implementation sequence and tests tied to observable requirements.

Assign stable acceptance IDs such as AC-01. Maintain a small acceptance matrix mapping each requirement to its observable expected behavior. Preserve IDs through revisions; explicitly mark replaced requirements rather than silently changing their meaning.

Scale detail to the change. Make routine engineering choices directly. Surface unresolved product choices that materially affect behavior; continue independent analysis while awaiting necessary answers.

## Stage 2: Fable spec review and Astra revision

Give Fable 5.1 the user request, spec, and repository access. Ask it to audit feasibility, intended behavior, missing journeys, incorrect assumptions, unnecessary complexity, data consistency, and the proposed tests. Require concrete counterexamples and file references where applicable.

Astra evaluates each finding as accepted, rejected with evidence, or unresolved. Revise the spec for accepted findings. Re-review with Fable when revisions change architecture, user behavior, migrations, or important acceptance criteria, or when the first review left substantive uncertainty. A wording-only change does not require another pass.

Default to at most three substantive review/revision rounds per stage. If material disagreement persists, summarize the exact decision needed and pause the dependent work rather than looping indefinitely or treating the review as passed.

Confirmed in-scope correctness, privacy, data-loss, security, and acceptance failures block completion. Missing required verification or a required model review also blocks a claim of completion. Cosmetic preferences and unrelated improvements are optional and should not restart review cycles. Investigate speculative concerns until they can be supported or rejected with evidence; model disagreement alone is not a blocker. At the round limit, escalate only a specific unresolved material issue and continue any independent work that remains valid.

### Attach the agreed spec to Linear

After Astra resolves the spec review and the spec satisfies any repository-required readiness gate, attach the exact agreed spec to the task's Linear ticket **before implementation**. Keep the durable spec in the repository and record its path and content hash in the handoff. Make the complete Markdown spec readable in Linear: append or update a clearly delimited `Accepted specification` section in the ticket description, preserving the original request and unrelated content. A local filesystem path alone is not an attachment. If using a native file attachment instead, verify that the uploaded document is accessible from the ticket.

With the bundled CLI, read/export the existing description, compose the merged description in a durable task file, then use the supported `set-desc <IDENT> <file>` and `verify-desc <IDENT> <file>` commands. Re-read immediately before writing to avoid overwriting intervening edits, and verify the saved spec by reading it back. Record the ticket URL and attached spec version/hash. If implementation later requires a material spec revision, repeat the affected review/readiness gate and refresh the ticket's accepted spec before resuming implementation. Missing Linear access or a failed attachment leaves this stage incomplete; report the concrete blocker.

## Stage 3: Implementation

Give the selected implementer the accepted spec, repository instructions, relevant code, and acceptance criteria. The selected implementer implements the scoped change and meaningful tests, runs the relevant checks, and reports deviations or unresolved issues. If implementation reveals a material flaw in the spec, return it to Astra for resolution and repeat the affected spec review before proceeding.

The coordinator verifies the actual diff and test results. Passing tests alone does not demonstrate spec compliance.

The selected implementer fills the acceptance matrix with implementation file references and test names/results or appropriate manual evidence for every acceptance ID. Mark unmet or unverified criteria explicitly. Reviewers independently check the spec against implementation before comparing this matrix; the author's mapping is evidence to examine, not proof of coverage.

## Stage 4: Fable code review and Astra adjudication

Give a new Fable 5.1 session the accepted spec, base SHA, complete implementation diff, and surrounding code access. Request bugs, logical errors, architectural regressions, missing acceptance behavior, and inadequate tests. Review callers and consumers beyond changed lines. Require severity, trigger, expected versus actual behavior, evidence, and a regression-test recommendation.

Astra validates findings against code and product intent. Send accepted corrections to the selected implementer. Preserve a decision record for rejected findings with concrete reasons. Verify fixes and run affected tests. Obtain another Fable pass when corrections are substantial or its blocking concerns remain unresolved.

## Stage 5: Fresh Astra review

Start a completely new Astra context with high reasoning. Supply only the user request, accepted spec, repository instructions, base SHA, and current implementation snapshot. Do not seed it with earlier reviews, author explanations, adjudication records, or conversation history. Ask it to independently examine correctness, architecture, integration behavior, and spec compliance.

After independent findings are returned, the coordinating Astra reconciles them with evidence and earlier decisions. The selected implementer implements accepted fixes and verifies them. Any substantive fix after this review requires a fresh focused Astra review of the affected behavior and its interactions. Record which final snapshot was reviewed; do not claim an earlier review covers later changes.

## Stage 6: Verify and publish

Confirm all required acceptance criteria are satisfied and substantive findings resolved. Run repository-required checks and tests appropriate to the final diff. Report any checks that cannot run; do not describe them as passing. If a required review or correctness blocker remains, stop before publication unless the user explicitly requests a draft PR with those limitations.

Fetch the target branch again before publication and compare its current SHA with the recorded review base. Inspect intervening changes for overlapping code, callers, schemas, dependencies, and assumptions. Integrate relevant base changes using the repository's normal merge/rebase practice, preserving user work and avoiding force-pushes to shared branches. Have the selected implementer resolve implementation conflicts, with Astra deciding changes to behavior. Re-run affected checks and reviews for material changes. If the base advanced without affecting the feature, record the assessed SHA and reason integration was unnecessary. Record the final implementation commit and reviewed base in the handoff and PR; disclose if the remote moves again during publication.

Inspect the final diff, stage only the task's files, commit, and push the feature branch. Check for an existing PR for that branch and update it rather than creating a duplicate. Open a PR against the agreed base with the problem, resulting behavior, relevant design decisions, verification, and any migration requirements. Use a body file or structured API argument for multiline descriptions.

Finish with the Linear ticket and PR links, a concise account of the change, actual models used, review outcomes, test results, and remaining limitations. Leave merging and deployment to a separate user instruction.

## Stage 7: Close the Linear ticket after verified staging deployment

Keep the ticket **In Progress** while implementation, review, merge, or staging deployment is pending. After the feature's PR has been merged into `staging` and that exact merge/squash commit is verified as deployed to the staging environment, move the Linear ticket to **Done** with the bundled CLI's `set-state <IDENT> "Done"` command (resolve the team's actual Done workflow state first). Verify the PR's merged status and target branch using the hosting provider, confirm the commit is contained in remote `staging`, and verify the staging deployment identifies that commit or a descendant that includes it. A completed build, an open or merely closed PR, or a merge into `staging` before deployment verification does not satisfy this condition.

This closeout step does not authorize merging or deployment: retain the separate user instruction required for each. When both authorized operations complete, perform the ticket transition without another confirmation. On a resumed task, inspect the existing PR, staging deployment, and ticket before retrying. Read the ticket back to verify Done and report its URL and the merge and deployment evidence. If the state update fails, report that staging deployment completed but ticket closeout remains incomplete.
