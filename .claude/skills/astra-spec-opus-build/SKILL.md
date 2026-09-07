---
name: astra-spec-opus-build
description: Begin a requested build with a Linear ticket, attach the agreed spec to that ticket, then proceed through Astra specification, Claude Fable 5.1 spec and code reviews, Opus 5 implementation through the Claude CLI, Astra adjudication and an independent final review, then push a branch and open a pull request. Use when the user requests this multi-model build workflow.
---

# Astra-Spec-Opus-Build

Carry the user's feature request through specification, implementation, independent reviews, verification, and a published PR. Follow the model assignments below. Invoking this workflow for a build authorizes creating or updating its Linear ticket, attaching the agreed spec, committing the scoped changes, pushing a feature branch, and creating a PR; it does not authorize merging or deployment. Creating or reviewing this skill alone does not authorize running a build.

## Model assignments

| Role | Model | Reasoning |
| --- | --- | --- |
| Spec author and decision owner | GPT-6 Astra (`gpt-6-astra`) | medium |
| Spec reviewer | Anthropic Claude Fable 5.1 through `claude` CLI | provider default |
| Implementer, including accepted fixes | Anthropic Claude Opus 5 (`claude-opus-5`) through `claude` CLI | high |
| First code reviewer | Anthropic Claude Fable 5.1 through `claude` CLI | provider default |
| Final independent code reviewer | GPT-6 Astra (`gpt-6-astra`) | high, fresh context |

Astra decides which review findings warrant changes. Opus 5 applies accepted code changes. Astra incorporates accepted spec changes. Do not simulate another model by assigning yourself its name. If the current session is not Astra at medium reasoning, delegate specification and adjudication to an explicitly configured Astra session.

## Start with a Linear ticket

Before specification or implementation, read the repository instructions and establish the intended Linear team/project, then create a Linear ticket in **In Progress** describing the request, scope, and known constraints. Use the AIOS toolkit's bundled Linear CLI where available; locate its `scripts/linear.mjs` entrypoint from the installed toolkit and inspect its help. Do not invent an `aios linear` command, team, project, parent issue, or issue identifier. Read the available `aios-linear` skill when the repository routes Linear work through it. If the destination cannot be established from repository context or the user's request, ask for the missing destination.

If the user supplies an existing ticket, or this is a resumed task with a recorded ticket, read and reuse it instead of creating a duplicate. Record the returned issue identifier and URL in the handoff. Preserve any separate brain row key and the repository's rules for branch names and trailers; a Linear identifier is not a substitute for a brain row key. When starting work on a reused ticket, move it to **In Progress**. Verify the ticket and its In Progress state by reading it back before starting Stage 1. If a create request has an uncertain outcome, inspect Linear before retrying.

The bundled CLI supports `create "<title>" --desc <file> --state "In Progress"` and `get <IDENT> --full`. Confirm its current destination-selection behavior and resolve the intended team's In Progress workflow state before creating the issue. Use `set-state <IDENT> "In Progress"` for a reused ticket. Keep descriptions in files and use subprocess argument arrays or safe shell quoting. Use configured credentials without printing them. Creating this skill does not itself create a Linear ticket or start the build.

## Preparation and execution

1. Read repository instructions, inspect git status, and establish the target repository and base branch. Fetch the base and record its SHA. Use an isolated worktree on a `codex/` feature branch when the existing checkout has unrelated work. Preserve user changes. Avoid pulling main into an unrelated feature branch.
2. Check `codex exec --help`, `claude --help`, authentication availability, and model availability using installed tooling. Resolve the exact provider identifier for **Fable 5.1** from authoritative configuration or provider documentation. The `fable` alias alone does not prove version 5.1. Verify availability of the exact implementation model `claude-opus-5`; the `opus` alias alone does not prove version 5. Never silently substitute a different model or version for any assigned role. If an exact model is unavailable, report the affected stage and request a substitute before completing that stage.
3. Keep a compact handoff directory outside the committed source tree, in permitted temporary storage. Record the request, base SHA, working directory, spec version, stage status, session identifiers, actual model identifiers, review findings, decisions, and verification results. Store the durable spec in the repository's usual spec location when appropriate. Keep temporary prompts and transcripts out of the PR.
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

For Opus 5 implementation and accepted fixes, run the Claude CLI from the implementation worktree with high effort and write access under the existing permission controls:

```sh
claude -p --model claude-opus-5 --effort high --output-format json --no-session-persistence --permission-mode acceptEdits --tools 'Read,Glob,Grep,Edit,Write,Bash' < "$implementation_prompt"
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

With the bundled CLI, read/export the existing description, compose the merged description in a temporary file, then use the supported `set-desc <IDENT> <file>` and `verify-desc <IDENT> <file>` commands. Re-read immediately before writing to avoid overwriting intervening edits, and verify the saved spec by reading it back. Record the ticket URL and attached spec version/hash. If implementation later requires a material spec revision, repeat the affected review/readiness gate and refresh the ticket's accepted spec before resuming implementation. Missing Linear access or a failed attachment leaves this stage incomplete; report the concrete blocker.

## Stage 3: Opus 5 implementation

Give Opus 5 the accepted spec, repository instructions, relevant code, and acceptance criteria. Opus 5 implements the scoped change and meaningful tests, runs the relevant checks, and reports deviations or unresolved issues. If implementation reveals a material flaw in the spec, return it to Astra for resolution and repeat the affected spec review before proceeding.

The coordinator verifies the actual diff and test results. Passing tests alone does not demonstrate spec compliance.

Opus 5 fills the acceptance matrix with implementation file references and test names/results or appropriate manual evidence for every acceptance ID. Mark unmet or unverified criteria explicitly. Reviewers independently check the spec against implementation before comparing this matrix; the author's mapping is evidence to examine, not proof of coverage.

## Stage 4: Fable code review and Astra adjudication

Give a new Fable 5.1 session the accepted spec, base SHA, complete implementation diff, and surrounding code access. Request bugs, logical errors, architectural regressions, missing acceptance behavior, and inadequate tests. Review callers and consumers beyond changed lines. Require severity, trigger, expected versus actual behavior, evidence, and a regression-test recommendation.

Astra validates findings against code and product intent. Send accepted corrections to Opus 5. Preserve a decision record for rejected findings with concrete reasons. Verify fixes and run affected tests. Obtain another Fable pass when corrections are substantial or its blocking concerns remain unresolved.

## Stage 5: Fresh Astra review

Start a completely new Astra context with high reasoning. Supply only the user request, accepted spec, repository instructions, base SHA, and current implementation snapshot. Do not seed it with earlier reviews, author explanations, adjudication records, or conversation history. Ask it to independently examine correctness, architecture, integration behavior, and spec compliance.

After independent findings are returned, the coordinating Astra reconciles them with evidence and earlier decisions. Opus 5 implements accepted fixes and verifies them. Any substantive fix after this review requires a fresh focused Astra review of the affected behavior and its interactions. Record which final snapshot was reviewed; do not claim an earlier review covers later changes.

## Stage 6: Verify and publish

Confirm all required acceptance criteria are satisfied and substantive findings resolved. Run repository-required checks and tests appropriate to the final diff. Report any checks that cannot run; do not describe them as passing. If a required review or correctness blocker remains, stop before publication unless the user explicitly requests a draft PR with those limitations.

Fetch the target branch again before publication and compare its current SHA with the recorded review base. Inspect intervening changes for overlapping code, callers, schemas, dependencies, and assumptions. Integrate relevant base changes using the repository's normal merge/rebase practice, preserving user work and avoiding force-pushes to shared branches. Have Opus 5 resolve implementation conflicts, with Astra deciding changes to behavior. Re-run affected checks and reviews for material changes. If the base advanced without affecting the feature, record the assessed SHA and reason integration was unnecessary. Record the final implementation commit and reviewed base in the handoff and PR; disclose if the remote moves again during publication.

Inspect the final diff, stage only the task's files, commit, and push the feature branch. Check for an existing PR for that branch and update it rather than creating a duplicate. Open a PR against the agreed base with the problem, resulting behavior, relevant design decisions, verification, and any migration requirements. Use a body file or structured API argument for multiline descriptions.

Finish with the Linear ticket and PR links, a concise account of the change, actual models used, review outcomes, test results, and remaining limitations. Leave merging and deployment to a separate user instruction.

## Stage 7: Close the Linear ticket after merge into main

Keep the ticket **In Progress** while implementation, review, or merge is pending. After the feature is finished and its PR has been merged into `main`, move the Linear ticket to **Done** with the bundled CLI's `set-state <IDENT> "Done"` command (resolve the team's actual Done workflow state first). Verify the PR's merged status and target branch using the hosting provider, and confirm the resulting merge/squash commit is contained in remote `main`. A completed build, an open or merely closed PR, or a merge into `staging` does not satisfy this condition.

This closeout step does not authorize merging: retain the separate user instruction required above. When an authorized merge completes, perform the ticket transition without another confirmation. On a resumed task, inspect the existing PR and ticket before retrying. Read the ticket back to verify Done and report its URL and the merge evidence. If the state update fails, report that the feature merged but ticket closeout remains incomplete.
