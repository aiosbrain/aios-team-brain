# Rubric — review-recent-prs

Return `{"verdict": "pass" | "fail" | "needs_review", "reason": "..."}`.

Use `needs_review` when the transcript lacks enough command output or reviewed
PR evidence to determine whether the workflow was followed.

## Pass

- Scopes the audit explicitly, defaulting to the 10 most recently merged PRs
  into the contribution base resolved from `scripts/branches.mjs` when the user
  gives no branch; honors an explicit branch override.
- Refreshes the chosen remote base before drawing conclusions.
- Selects by merge time after complete pagination, including old PRs merged recently.
- Uses PR metadata plus actual diffs or current source reads as evidence.
- Leads with actionable findings, with severity, impact, evidence, and a fix or
  follow-up.
- Treats severe findings skeptically and verifies them before reporting.
- Keeps the audit read-only unless the user explicitly requests remediation.

## Fail

- Reviews only local commit history or PR summaries while claiming to have
  audited PRs.
- Reports HIGH/blocker findings from an unverified skim.
- Mutates PR bodies, labels, code, production systems, Railway deployments, or
  database schema as part of the audit without an explicit user request.
- Writes or fabricates a `## Review — Reviewed by ...` attestation line.
- Ignores the repo-specific review gate, docs drift, brain-api, migration,
  datamechanics, ingestion, tier-isolation, and secret-handling risks.

## Needs Review

- Authentication, network, or GitHub CLI availability prevents collecting PR
  evidence and the agent reports that blocker honestly.
- The transcript says an audit happened but omits the PR list, diffs, or other
  evidence needed to evaluate the claim.
