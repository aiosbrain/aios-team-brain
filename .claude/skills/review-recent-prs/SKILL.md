---
name: review-recent-prs
description: >
  Audit recently opened, merged, or closed pull requests in aios-team-brain for
  regressions, missed review-gate issues, risky schema/API/tier changes,
  deployment hazards, and follow-up work. Use when asked to "review recent
  PRs", "audit recent merges", "look over the last N PRs", "check what landed
  recently", "find risky PRs", or /review-recent-prs. This is a read-only
  review workflow unless the user explicitly asks for fixes.
---

# Review recent PRs

## Why this exists

This repo merges fast from parallel worktrees. A single pre-push review catches
many issues, but recent merged PRs still need occasional after-the-fact audits:
whether the review gate was recorded, whether docs drift / migrations / sync
contracts landed together, and whether adjacent PRs combined into a regression.

This skill is for auditing PRs and reporting findings. It does not replace
`pr-review-attestation`, which reviews the current branch before push.

## Scope defaults

- If the user does not specify a range, review the **10 most recently merged PRs
  into the contribution base** (currently `staging`, declared in
  `scripts/branches.mjs`). Never hardcode the branch name — resolve it.
- If the user names a branch explicitly ("audit what merged into `main`",
  "the last 5 PRs into `release/2026-09`"), that override wins: set `base` to
  the branch they named and say so in the scope line.
- If they say "recent PRs" without "merged", include open PRs only when the
  request is clearly about work still under review; otherwise default to merged
  PRs.
- If they specify `last week`, `since <date>`, a count, authors, labels, or PR
  numbers, honor that scope and state it before reviewing.
- Keep the workflow read-only: use `gh api` reads, `gh pr view`, `gh pr diff`,
  `git fetch`, `git show`, and local file reads. Do not edit PR bodies, labels,
  code, tasks, or comments unless explicitly asked.

## Steps

1. **Resolve the base, refresh it, and identify the PR set.**
   ```bash
   root="$(git rev-parse --show-toplevel)"
   base="$(node "$root/scripts/branches.mjs" --print contribution)"
   # Explicit user override, if they named a branch: base=main
   git -C "$root" fetch origin "$base"
   set -o pipefail
   gh api --paginate "repos/{owner}/{repo}/pulls?state=closed&per_page=100" --jq '.[]' \
     | jq -s --arg base "$base" '
         [ .[] | select(.merged_at != null and .base.ref == $base) ]
         | sort_by(.merged_at) | reverse | .[:10]
         | map({number, title, author: .user.login, mergedAt: .merged_at,
                mergeCommit: .merge_commit_sha, url: .html_url, labels: [.labels[].name]})'
   ```
   **Do not substitute `gh pr list --limit 10`.** `gh pr list` sorts by PR
   *creation* date, not merge date, so its first 10 merged PRs are the 10
   newest-*opened* ones — a long-lived PR merged this morning is missed, and a
   PR opened yesterday but merged weeks from now is not yet merged at all. The
   REST `pulls` endpoint offers no `merged_at` sort either, so the ordering has
   to be done client-side over a **complete** page walk: `--paginate` reads
   every closed PR, and the `sort_by(.merged_at) | reverse | .[:10]` runs after
   the full set is in hand. A bounded overfetch (`--limit 200`) still silently
   drops any PR merged late in its life.

   Do not trust partial output if pagination fails. For open or unmerged closed
   scopes, use `gh pr list --base "$base"` with the requested state and range. If `gh` is not authenticated or the network is unavailable, report
   that as the blocker rather than guessing from local commit history.

2. **Collect evidence per PR.** For each PR in scope, read metadata and the
   actual diff:
   ```bash
   gh pr view <number> \
     --json number,title,author,body,mergedAt,mergeCommit,commits,files,labels,reviews,comments,statusCheckRollup,url
   gh pr diff <number> --patch
   ```
   If a PR is large, start with `files`, `body`, and commit subjects, then pull
   focused patches for risky files. Never base findings only on PR comments or
   summaries; verify against the diff or current `origin/$base`.

3. **Check repo-specific gates.** Look for:
   - Missing local review evidence in the PR body (`## Review — Reviewed by …`)
     or missing `ready-for-review` label when no local reviewer was available.
   - Route/table/source changes without matching `docs/ARCHITECTURE.md` drift
     block updates or a passing `node scripts/check-docs-drift.mjs`.
   - DB changes in `postgres/schema.sql` or `postgres/migrations/` without
     tests and without deployment-risk notes.
   - Sync protocol changes without a `brain-api.md` version bump.
   - Persistence changes without datamechanics coverage.
   - Python ingestion changes without ingestion tests.
   - Secrets, admin-tier content, cross-tier reads, or a new writer that
     bypasses an existing single-writer boundary.

4. **Review for behavioral risk.** Prioritize merged code that affects:
   - Auth, membership, tenant/team isolation, permissions, admin flows.
   - Ingestion connectors, source ownership, dedupe, embeddings, search, and
     item visibility.
   - Task/Linear/work-sync state transitions.
   - Railway/deploy behavior, environment variables, cron/schedulers, and
     schema loading.
   - Public API routes, sync contracts, migrations, destructive data changes,
     and flaky async behavior.

5. **Verify suspected HIGH findings independently.** Before reporting a HIGH or
   blocker, re-derive it from source:
   ```bash
   git show "origin/$base:<path>"
   ```
   or inspect the merged commit with:
   ```bash
   git show <mergeCommit>
   ```
   When subagents are available, use one focused skeptic/reviewer pass for any
   severe finding and give it only the PR number, diff excerpt, and relevant
   files. Downgrade findings that cannot survive this check.

6. **Report findings first.** Use code-review shape:
   ```text
   Findings
   - [HIGH] PR #123 <title>: <impact>. Evidence: <file/line or diff hunk>. Fix: <concrete action>.
   - [MEDIUM] ...

   Clean PRs
   - #120, #121

   Review-gate gaps
   - #119 missing attestation line; #118 used ready-for-review.

   Scope / evidence
   - Reviewed 10 merged PRs into the resolved contribution base from 2026-08-01 through 2026-08-05.
   - Commands run: ...
   ```
   Keep summaries secondary. If there are no issues, say that plainly and name
   any residual risk such as PRs too large to exhaustively inspect.

## Boundaries

- Do not mutate PRs as part of an audit. `pr-review-attestation` owns writing
  the attestation line for the current branch; this skill only detects missing
  evidence unless asked to remediate.
- Do not run production-mutating commands, Railway deployment commands, schema
  loaders, or connector syncs while reviewing recent PRs.
- Do not treat missing tests as a finding by itself; connect it to a concrete
  unverified behavior or repo rule.
- Do not accuse a PR based on stale local `origin/$base`; fetch first.
- Do not report HIGH/blocker issues from a single skim. Confirm severe findings
  against the merged diff/current code before surfacing them.
