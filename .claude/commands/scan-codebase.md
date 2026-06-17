---
description: Scan a repo's git history + scaffolding and push codebase metrics to the brain
argument-hint: <local-path> <slug> [owner/repo]
---

Run the codebase analytics scanner for the repo at the path/slug in $ARGUMENTS and push the
results to the brain. The brain computes the agentic/health scores from the raw metrics.

Steps:
1. If the repo has a coverage script, generate a fresh report first so coverage is real:
   `(cd <local-path> && npm run coverage)` — if it errors or doesn't exist, continue (coverage
   will be reported as null, not a failure).
2. Run the scanner with a 12-week backfill so the trend populates:
   `GITHUB_TOKEN=… aios-ingest scan --path <local-path> --slug <slug> --full-name <owner/repo> --backfill 12`
   - Set `GITHUB_TOKEN` in the env (never as a flag) to enrich Issues/PRs + repo metadata.
   - Requires `BRAIN_URL`, `AIOS_API_KEY`, `AIOS_TEAM` in the env (issue a key via the `admin` skill).
3. Report the scanned counts (commits, AI-assisted, contributors, coverage, backfill points).

Never print the API key or GitHub token.
