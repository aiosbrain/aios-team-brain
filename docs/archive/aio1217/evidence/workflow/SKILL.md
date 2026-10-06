---
name: astra-spec-claude-build
description: Run a requested Linear-first Astra specification and subscription Claude Opus 5.5 build, with independent Opus, Astra and blind Sol reviews, quota-only builder fallback, remote checkpoints and a staging PR. Use when the user requests this multi-model workflow; editing the skill does not start a build.
---

# Astra-Spec-Claude-Build

Carry the user's feature request through specification, implementation, independent reviews, verification, and a published PR. Follow the model assignments below. Invoking this workflow for a build authorizes creating or updating its Linear ticket, attaching the agreed spec, committing the scoped changes, pushing a feature branch, and creating a PR; it does not authorize merging or deployment. Creating or reviewing this skill alone does not authorize running a build.

Invoking this workflow authorizes sending the necessary task-scoped request, specification, source excerpts, committed and working-tree diff, changed-file list, sanitized Git status and relevant verification evidence to the assigned Claude builder/reviewer through the subscription-authenticated CLI. This includes private repository material needed for the assigned scope; do not ask for another confirmation for these prescribed reviews. Minimize the payload and exclude credentials, private member/customer data, unrelated files and unrelated handoff/history. If necessary material falls outside this authorization, obtain specific authorization for that material rather than omitting required coverage or expanding recipients.

Use existing user authorization in the normal tool approval mechanism. If automatic approval review rejects a dispatch, present the explicit workflow invocation, authorized payload and sanitized scope through that mechanism; never bypass the rejection or claim a skill changes tool permissions. Ask the user only if the action remains blocked after presenting that evidence or materially exceeds the authorized scope, and report the actual rejection and its stated reason. Editing this skill does not itself start a build or send review material.

## Model assignments

| Role | Model | Reasoning |
| --- | --- | --- |
| Spec author and architectural decision owner | GPT-6 Astra (`gpt-6-astra`) | medium |
| Spec reviewer | Anthropic Claude Opus 5.5 through `claude` CLI | provider default |
| Initial implementer, including accepted fixes | Anthropic Claude Opus 5.5 (verified version-specific identifier) through `claude` CLI | high |
| First code reviewer | Anthropic Claude Opus 5.5 through `claude` CLI | provider default |
| Independent Astra code reviewer | GPT-6 Astra (`gpt-6-astra`) | high, fresh context |
| Mandatory blind final code reviewer | GPT-6.1 Sol (`gpt-6.1-sol`) | high, fresh independent context |
| Sole coordinator | GPT-5.6 Terra (`gpt-5.6-terra`) | low initially; medium for dependent slices |
| Evidence-based stronger coordination | GPT-5.6 Sol (`gpt-5.6-sol`) | medium, bounded escalation; then return to Terra |

Astra remains the specification author and owns architectural/spec decisions. The sole coordinator handles routine evidence reconciliation under the rules below; the active implementer applies accepted changes, including after fallback. Use actual explicitly configured model sessions, not role-name simulation. Keep independent reviewers separate from authors, builders and adjudicators.

## Coordination and evidence ownership

Exactly **one active coordinator** owns supervision, checks, review routing and the current-state handoff. Start with GPT-5.6 Terra **LOW**, use Terra **MEDIUM** for dependent slices, and escalate to the designated stronger coordinator, GPT-5.6 Sol **MEDIUM**, for concrete consequential uncertainty or repeated loss of continuity, overlooked dependencies or corrective steering. Record the observed failures, competing evidence, acceptance impact and bounded escalation decision; repeatedly forcing the lighter model through rework is not efficiency. A single routine test failure does not justify escalation. Return to Terra once the issue is settled and continuity is reliable. Architectural/shared-contract/security uncertainty goes to Astra **high**; material spec changes return to the assigned author and affected gate. Builder and independent-review assignments stay fixed; Astra must not become the persistent coordinator.

Dispatching a worker, preparing a prompt, reporting a failed check or receiving a review verdict is not completion. Keep the coordinating turn active: supervise through the terminal result or a safe timed preservation point, then advance the next authorized step. Repair failed checks and reconcile findings rather than stopping at intermediate milestones. Stop only when the requested outcome is complete, the user requests a pause, or a concrete blocker prevents further authorized progress. Before stopping, durably preserve worker identities/state, task-owned partial work, unresolved evidence, the blocker and the exact next action under the checkpoint and quota rules. A preserved interruption is not a completed slice.

A parent chat receives milestone summaries and handles explicitly assigned actions only; it must not duplicate supervision, artifact reads, checks or handoff maintenance. Transfer ownership explicitly before another context coordinates, and verify that only the successor remains active. Keep the builder session and sole source writer intact; transferring coordination does not restart the builder or authorize a second writer.

Use foreground scripts and event-driven waits for routine worker monitoring, terminal-result capture, checkpoint deadlines, checks and independent remote-revision verification. Scripts retain evidence and emit compact state changes; models intervene at meaningful milestones, failures, decisions, deadlines and quota thresholds. Avoid model polling and repeated unchanged narration. Scripts honor normal approvals and may not expand external-action authorization.

Maintain **one compact canonical current-state handoff** in durable permitted storage outside committed source: accepted requirements/spec hash and acceptance status; exact base/local/reviewed/remote revisions and dependency fingerprints; active worker identities, actual models and states; unresolved findings/decisions; evidence links and inspected scope; exact next action; usage/reset evidence; checkpoint deadline. Load this concise state and relevant evidence, not the accumulated archive. Archive history separately and load it only for a relevant decision or invalidated evidence. When historical material dominates the useful working context, transfer coordination to fresh context at a coherent phase boundary using this record, verify live state and retire the outgoing coordinator. Preserve accepted requirements, unresolved findings and active worker identities; do not reconstruct unrelated history or discard valid evidence.

Measure efficiency per **completed, verified slice**, alongside acceptance and review coverage, reopened defects and rework. Record available cached input, uncached input and output separately from account-wide quota/reset data; do not double-count cached input included in a reported input total. Mark incomplete slices and unavailable measurements explicitly. Tokens per hour alone establish neither quality nor cost savings nor causal improvement. Preserve quota thresholds, authentication, authorization and checkpoint protections; never promise unmeasured savings.

## Start with a Linear ticket

Before specification or implementation, read project instructions and establish the actual Linear destination. Use the installed AIOS toolkit's bundled `scripts/linear.mjs`; inspect its help and read `aios-linear` when project routing requires it. Never invent an `aios linear` command, team/project/parent or issue key. Ask only for genuinely missing destination information.

Reuse and read back a supplied/resumed ticket; otherwise create the requested task in **In Progress**. Preserve any distinct canonical brain row key, branch naming and `AIOS-Work:` trailer rules. Do not substitute a Linear ID for the brain key. Record the verified identifier, URL and In Progress state before Stage 1. Inspect uncertain creation outcomes before retrying.

Supported CLI forms include `create "<title>" --desc <file> --state "In Progress"`, `get <IDENT> --full` and `set-state <IDENT> "In Progress"`; confirm installed destination/state selection. Keep multiline text in files, use argument arrays or safe quoting, and never print credentials.

## Preparation and execution

1. Read repository instructions, inspect git status, and establish the target repository and use `staging` as the feature base and PR target. Fetch `origin/staging` and record its SHA. Do not target `main` unless the user explicitly changes this instruction. Use an isolated worktree on a `codex/` feature branch when the existing checkout has unrelated work. Preserve user changes. Avoid pulling main into an unrelated feature branch.
2. Verify installed CLI help, actual model identifiers and authentication through the Claude protocol below. Record `opus_55_model_id`; verify the initial builder and its alternate before their first use. An alias alone cannot prove Opus 5.5. For non-quota model unavailability or review-role substitutions, report the affected stage and obtain an authorized substitute; do not silently change assignments.
3. Establish the canonical current-state handoff and foreground supervisor described above. Store the durable spec in the repository's usual spec location; keep prompts, transcripts and archived history outside the PR.
4. Run writers sequentially against the implementation worktree. Run reviews against a stable snapshot and record the reviewed commit or diff fingerprint. Each worker receives the request, relevant repository instructions, necessary artifacts, and its bounded role. Workers must not recursively invoke this whole workflow or independently push, merge, deploy, or open PRs.

### Remote-verified checkpoints

Create and verify local task-owned checkpoints at least every 10–15 minutes during active editing and before major phase transitions, following stricter project rules. Commit and push scoped checkpoints after meaningful slices, **at least every 30 minutes while editing**, and **before long checks, reviews or handoffs**. Retain the 30-minute checkpoint cadence during active review/fix/verification work. A foreground supervisor tracks deadlines and wakes the coordinator when action is needed. Reset the clock only after a successful push and an independent remote branch SHA readback; record time, exact revision, remote branch and next deadline in the canonical handoff.

Coordinate with the sole writer at a recoverable boundary, freeze review snapshots, and include only task-owned changes. Never include credentials, temporary transcripts or unrelated edits. A checkpoint can be unfinished; record remaining work. If nothing changed, verify that remote already holds the checkpoint instead of making an empty commit. A checkpoint alone does **not** trigger another review or full test suite; satisfy required pre-push gates and reuse valid coverage only under the review rules below.

Keep permission controls and required gates. If a gate or external failure blocks a push, save a local checkpoint, report the blocker and overdue deadline, and resolve it promptly. Push and verify when cleared; never skip the interval silently or bypass a gate for lower usage.

### Claude CLI launch and result checks (Hermes integration)

The Hermes Second Brain workflow demonstrated subscription CLI calls using `claude-opus-5-5`. Treat that as a known working identifier, then verify current availability and reported model during preflight. Resolve the installed `claude` executable rather than copying Hermes's machine-specific path.

- Check `claude auth status` using the same execution context as the planned call. On macOS, a restricted Codex workspace process may lack access to the signed-in Keychain credential. If necessary, use the normal approved `require_escalated` command path; honor approval decisions and reuse authorization only within its existing scope. Do not extract credentials, copy OAuth tokens, or switch to API billing. Do not diagnose an account/model restriction from sandbox authentication failure alone.
- Remove both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the Claude child environment. Use subprocess argument arrays or safely quoted prompt files. Check installed help before using the flags below. Do not use `--bare` for subscription calls: it skips OAuth/Keychain authentication.
- Perform one minimal read-only, no-tools preflight through the same approved execution path before the first Claude stage. Use `--safe-mode`, `--tools ''`, `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, and `--no-session-persistence`. Require the requested final text, a successful terminal result, and the exact reported model. Safe mode disables automatic customizations: explicitly include applicable repository instructions and necessary context in every worker prompt.
- Use the foreground supervisor for Claude monitoring and result capture. Use `--output-format stream-json --verbose`, preserve the event stream and stderr separately, and surface public progress without exposing private reasoning. Record the `system/init` model and session ID. An active stream without final text is not a reason to launch a duplicate worker.
- Require process exit zero, a successful terminal `result` event, and substantive final text. When the terminal `result` text is empty, collect assistant **text** blocks and accept them only with a successful terminal event and demonstrated coverage of the requested task. Thinking/progress events and exit zero alone do not constitute a completed review. Diagnose recorded errors before retrying.
- Treat `permission_denied` events as incomplete operations. `acceptEdits` does not authorize every Bash command. Run necessary diagnostic checks through the coordinator's normal permission controls; verify actual edits and tests rather than trusting a worker's completion claim. For additional task-owned worktrees or artifacts, use scoped `--add-dir` paths when supported; this does not bypass command approvals.
- Fresh spec/code reviewers remain ephemeral and independent. Provide complete material for the assigned scope using stable artifacts and read-only tools, or a complete tool-free inline bundle. If more context is required, use a scoped read-only follow-up with `--permission-mode dontAsk --tools 'Read,Glob,Grep'` and record the missing coverage. The coordinator runs diagnostic tests. A resumable builder may retain session persistence and use `--resume <recorded-session-id>` for accepted fixes; stop the previous writer first. Never resume the builder as a reviewer.
- Record supported `rate_limit_event` evidence for capacity and fallback decisions. Cost estimates and token counts are not quota percentages. Retain this skill's existing Sol 6.1/Opus 5.5 fallback rules; Hermes's different builder-routing and quota policies are not imported.

Example no-tools preflight (through the normal approved execution path):

```sh
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude --safe-mode -p --model "$opus_55_model_id" --effort high --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence --output-format stream-json --verbose < "$preflight_prompt"
```

### Automatic builder fallback on credit or usage limits

Use the assigned initial builder. On explicit provider/CLI credit, quota or usage/rate-limit evidence, automatically switch **Sol 6.1 ↔ Opus 5.5**, repeatedly if needed, without further confirmation. Keep the replacement until it finishes or hits its own limit. Specification, adjudication and independent-review roles are not builder fallbacks. Test/permission/authentication failures or unavailable identifiers are not credit exhaustion; follow normal approvals.

Before switching, confirm the outgoing writer and children stopped. Preserve partial/untracked task work; never reset or restart. Update the canonical handoff with limit/reset evidence, models, exact revisions, remaining acceptance work, checks and pending fixes. Give the replacement the accepted requirements, applicable project instructions, current diff and relevant evidence; verify its actual model/results and report the switch.

Retry an exhausted alternate only after its reported reset/retry time or fresh capacity evidence. If neither builder is eligible, save state, report the blocker/reset times, and resume when capacity returns. Never bounce indefinitely, purchase credits, consume usage-reset credits or enable API-key billing. Preserve valid stages and rerun only invalidated checks/reviews.

Use the assigned implementation CLI with high reasoning/effort and existing permission controls.

### Review material, coverage and findings

For each assigned review scope, generate readable artifacts with accepted requirements, exact base/HEAD/status, changed-file list and complete material for that scope, including relevant callers, consumers and interactions. Keep the full task diff available: committed, staged, unstaged and task-owned untracked content; account explicitly for renamed/deleted/binary files. Exclude credentials and unrelated user files. Opus Read/Glob/Grep cannot generate the diff itself. Prefer stable artifact paths with scoped reading over repeatedly embedding entire bundles; a tool-free reviewer still needs all necessary material inline.

Fingerprint source, artifacts and relevant dependencies and freeze writes during review. Partition broad coverage explicitly by acceptance IDs and interacting boundaries, assign reviewers their complete partitions, and track what each actually inspected. Preserve the full required role coverage across partitions; mandatory blind final reviews still examine the complete final contract and integrations. Missing, denied or uninspected coverage is **NOT VERIFIED**, never PASS. An author's acceptance matrix is evidence to check, not the reviewer's conclusion.

Concise reporting follows sufficient analysis; it does not replace it. Do not impose arbitrary token or output caps on builders/reviewers, lower required reasoning effort, omit necessary context or accept incomplete coverage to meet a usage target. Inspect affected callers, privacy boundaries, shared contracts and retry/recovery behavior sufficiently, then summarize findings. Scale specifications and meaningful tests to risk while preserving every required role and final check. Reuse verified evidence only when unchanged scope and dependencies justify it; repeat checks/reviews for changes, failures or unresolved evidence, not merely to narrate progress.

Summarize findings with severity, acceptance impact, concrete trigger, expected versus actual behavior, evidence and a meaningful regression recommendation. Separate confirmed blockers, speculative concerns requiring investigation and optional polish. Honor repository HIGH/blocker skepticism gates; focus escalation on a specific unresolved consequential decision.

Build coherent slices and batch accepted fixes by shared cause. After fixes, review affected behavior **and interactions**. Retain unaffected coverage only with unchanged fingerprints and dependencies that justify reuse, recording the assessment. Repeat broad reviews when architectural/shared-contract changes invalidate prior coverage. A changed snapshot invalidates affected coverage; never claim an earlier review covers later changes without that analysis.

Run meaningful affected checks and all repository-required final checks through the foreground supervisor. Repeat only for changes, failures or unresolved evidence. A routine checkpoint, wording-only change or already-verified result does not justify another full suite. Required reviews and final checks remain mandatory regardless of measured usage.

### Resume and transfer coordination

Read the canonical current-state record first; have scripts verify branch/status, exact revisions, worker states, remote checkpoint and existing PR before action. Load archived artifacts only for relevant gaps. Continue suitable active workers and valid stages; never start a duplicate writer or coordinator. Transfer ownership to fresh context at a coherent phase boundary without restarting workers. Reconcile uncertain commits/pushes/PR requests with remote state before retrying; reconstruct and repeat only evidence that is genuinely missing or invalidated.

Use available model-selectable delegation tools or the installed CLI. The following Codex pattern starts a new context and can read a task prompt from stdin:

```sh
codex exec --ephemeral -C "$worktree" -m gpt-6-astra -c 'model_reasoning_effort="medium"' -s read-only -o "$spec_output" - < "$spec_prompt"
```

For Opus 5.5 implementation and accepted fixes, run the Claude CLI from the implementation worktree with high effort and write access under the existing permission controls:

```sh
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude --safe-mode -p --strict-mcp-config --mcp-config '{"mcpServers":{}}' --model "$opus_55_model_id" --effort high --output-format stream-json --verbose --no-session-persistence --permission-mode acceptEdits --tools 'Read,Glob,Grep,Edit,Write,Bash' < "$implementation_prompt"
```

For Sol fallback implementation and accepted fixes, use the same implementation worktree:

```sh
codex exec --ephemeral -C "$worktree" -m gpt-6.1-sol -c 'model_reasoning_effort="high"' -s workspace-write --json -o "$implementation_output" - < "$implementation_prompt"
```

Inspect the process result, reported model, permission denials, actual diff, and verification results. Handle any required command approvals through the normal permission controls; a denied operation is not completed work.

For independent Astra and blind Sol final reviews, use separate fresh `codex exec --ephemeral` calls with the assigned model, `high` reasoning and `read-only`. Never resume/fork authoring contexts; verify installed flags.

For Opus 5.5 reviews, use a fresh independent session with complete assigned-scope material and repository instructions. Never resume the builder as reviewer. A tool-free invocation requires the complete necessary material inline:

```sh
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN claude --safe-mode -p --model "$opus_55_model_id" --effort high --tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence --output-format stream-json --verbose < "$review_prompt"
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

## Stage 2: Opus 5.5 spec review and Astra revision

Give Opus 5.5 the user request, spec, and repository access. Ask it to audit feasibility, intended behavior, missing journeys, incorrect assumptions, unnecessary complexity, data consistency, and the proposed tests. Require concrete counterexamples and file references where applicable.

Astra evaluates each finding as accepted, rejected with evidence, or unresolved. Revise the spec for accepted findings. Re-review with Opus 5.5 when revisions change architecture, user behavior, migrations, or important acceptance criteria, or when the first review left substantive uncertainty. A wording-only change does not require another pass.

Default to at most three substantive review/revision rounds per stage. If material disagreement persists, summarize the exact decision needed and pause the dependent work rather than looping indefinitely or treating the review as passed.

Confirmed in-scope correctness, privacy, data-loss, security, and acceptance failures block completion. Missing required verification or a required model review also blocks a claim of completion. Cosmetic preferences and unrelated improvements are optional and should not restart review cycles. Investigate speculative concerns until they can be supported or rejected with evidence; model disagreement alone is not a blocker. At the round limit, escalate only a specific unresolved material issue and continue any independent work that remains valid.

### Attach the agreed spec to Linear

After Astra resolves the specification review and repository readiness gates pass, attach the **exact complete accepted spec before implementation**. Record its durable repository path, version and hash. Export/read the existing Linear description immediately before mutation; preserve unrelated content and add a delimited `Accepted specification` section. A local path alone is not an attachment. A native uploaded attachment must be verified accessible from the ticket.

Use installed `set-desc <IDENT> <file>` and `verify-desc <IDENT> <file>`, then read back the saved text. Missing access or failed verification blocks implementation. Material revisions require affected review/readiness and refreshed exact attachment before resuming.

## Stage 3: Implementation (Opus 5.5 first, automatic builder fallback)

Give the active implementer the accepted spec, repository instructions, relevant code, and acceptance criteria. The active implementer builds coherent slices and meaningful tests, reports deviations or unresolved issues, and requests checks from the sole coordinator’s foreground supervisor; do not duplicate check execution. If implementation reveals a material flaw in the spec, return it to Astra for resolution and repeat the affected spec review before proceeding.

At meaningful milestones the coordinator verifies the actual diff and captured check outcomes. Passing tests alone does not demonstrate spec compliance.

The active implementer fills the acceptance matrix with implementation file references and test names/results or appropriate manual evidence for every acceptance ID. Mark unmet or unverified criteria explicitly. Reviewers independently check the spec against implementation before comparing this matrix; the author's mapping is evidence to examine, not proof of coverage.

## Stage 4: Independent Opus 5.5 code review and evidence reconciliation

Give a fresh Opus 5.5 session the accepted spec, exact base, stable implementation material and complete assigned-scope caller/consumer context. Follow the coverage and concise finding rules above. The sole coordinator reconciles routine findings against code and intent, escalating consequential uncertainty or demonstrated repeated coordination failures to Sol MEDIUM under the coordination rules and architectural/shared-contract/security decisions to Astra HIGH. Return to Terra after the bounded decision. Preserve evidence for rejected findings; send accepted fixes to the active implementer under fallback rules. Verify affected checks and review behavior/interactions without repeating unaffected coverage automatically.

## Stage 5: Independent Astra and mandatory blind Sol final reviews

Preserve the independent Astra **high** review: start a completely fresh context with only the user request, accepted spec, repository instructions, exact base and stable implementation snapshot with relevant callers/interactions. Do not seed it with earlier reviews, author explanations, adjudication records or conversation history. It independently examines correctness, architecture, integration behavior and spec compliance.

The **mandatory fresh blind Sol final review** uses GPT-6.1 Sol (`gpt-6.1-sol`) at **high**, read-only, in a separate context after the implementation is ready. This is additional to the preserved Opus and Astra reviews, not the coordinator's GPT-5.6 Sol uncertainty escalation. Even when Sol built the code, never resume/fork its builder or adjudicator context as reviewer. Supply the same complete final contract/snapshot/caller material; withhold prior findings, author conclusions and decision history until its independent findings are returned. Missing final Sol coverage blocks completion.

After independent findings return, the sole coordinator reconciles evidence and earlier decisions, using the decision escalation rules above. The active implementer batches accepted fixes and the supervisor runs affected checks. Substantive fixes require fresh focused review by the affected final-review role(s), covering behavior and interactions; architectural/shared-contract changes require broad re-review when prior coverage is invalidated. Record exact reviewed snapshots and preserved coverage; do not claim whole-task PASS with missing review scope.

## Stage 6: Verify and publish

Confirm all required acceptance criteria are satisfied and substantive findings resolved. Run all repository-required final checks and meaningful affected tests for the final diff; reuse only justified unchanged evidence under the coverage rules above. Report any checks that cannot run; do not describe them as passing. If a required review or correctness blocker remains, stop before publication unless the user explicitly requests a draft PR with those limitations.

Before publication, fetch `origin/staging` and compare it with the reviewed base. Inspect new code, callers, schema, dependencies and assumptions. Integrate relevant changes through normal project merge/rebase practice, preserving user work and avoiding shared-branch force-pushes. The sole implementer resolves conflicts under the coordinator's decision/escalation rules. Rerun invalidated checks/reviews. If advancement is unrelated, record the assessed SHA and why integration was unnecessary; disclose later remote movement.

Stage only task files, commit and push normally. Update an existing branch PR rather than creating a duplicate. Explicitly create or retarget to **staging** (`gh pr create --base staging`); read back `baseRefName` before claiming publication. Use a body file or structured multiline argument with the problem, resulting behavior, reviewed base/final SHA, actual validation, design decisions and migration needs. Keep repository attestation and approval gates.

Finish with the Linear ticket and PR links, a concise account of the change, actual models used, review outcomes, test results, and remaining limitations. Leave merging and deployment to a separate user instruction.

## Stage 7: Close the Linear ticket after merge into main

Keep the ticket **In Progress** until finished work is merged into `main`, with provider-verified merged status/base and merge or squash commit contained in **remote main**. A completed build, open/closed PR or staging merge is insufficient. This does not authorize a merge or deployment.

After a separately authorized qualifying merge, resolve the actual Done state, run `set-state <IDENT> "Done"` and read back without another confirmation. Inspect existing PR/ticket state before retrying. Report the ticket URL and containment evidence; if closeout fails, report the merged work and outstanding ticket transition honestly.
