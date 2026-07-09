---
name: test-ci-wiring-audit
description: >
  Find test files on disk that run in neither `npm test` nor CI (orphaned tests —
  false confidence) plus stale coverage reports that cite deleted files. Use when
  asked "is this test actually running", "check test wiring", "orphaned tests",
  "is the coverage report fresh", or /test-wiring-check. Static parsing only —
  flags issues and suggests fixes, never edits wiring itself.
---

# Test/CI wiring audit

## Why this exists

A 2026-07-09 audit of this repo found `coverage/coverage-summary.json` was 12
days stale and cited `lib/auth/supabase-auth.ts` — a file deleted in the
supabase-removal refactor — as a top-15 worst-covered file, while CI was
actually green across 143 test files. A stale coverage report can point at
dead file paths and misrepresent real coverage; a test file that exists on
disk can silently run in neither `npm test` nor CI and give false confidence.
Both failure modes are purely static/mechanical to detect — no code execution
needed.

## Steps

1. **Enumerate test files on disk.**
   ```bash
   git ls-files '*.test.ts' '*.test.tsx' '*.test.mjs'
   # plus ingestion-side pytest files, e.g.:
   git ls-files 'ingestion/**/test_*.py' 'ingestion/**/*_test.py'
   ```
   Exclude `node_modules/` and `.next/` (should already be excluded by
   `git ls-files`, but double-check if falling back to `find`/`glob`).

2. **Parse what's actually wired.**
   - `package.json`: read the `scripts.test` chain (and any script it calls
     transitively — `pretest`, `test:unit`, `test:integration`, etc.) and expand
     every glob/pattern it passes to the test runner.
   - `.github/workflows/*.yml`: read every `test`-labeled step/job, including
     matrix jobs, and any Python-side step (`pytest`, `python -m pytest`, tox).
   - Build the set of file *patterns* actually invoked by each surface (npm
     script vs. CI workflow) — don't assume they're identical.

3. **Classify every test file found in step 1** against the two wired sets from
   step 2:
   - **both** — covered by `npm test` and CI. Fine.
   - **one-only** — runs locally but not in CI, or vice versa. **Flag.**
   - **neither** — matches no invoked pattern in either surface. **ORPHANED.**

4. **Coverage staleness check.**
   ```bash
   stat -f %m coverage/coverage-summary.json   # or ls -l / date -r, mtime
   git log -1 --format=%ci origin/main
   ```
   If the coverage report's mtime predates the latest `main` commit by a
   meaningful margin (days, not minutes), flag it as stale. Independently, for
   every file the report names as a top-offender / worst-covered file, verify
   it still exists on disk (`git ls-files --error-unmatch <path>` or a plain
   existence check). Any named file that no longer exists is hard evidence the
   report is stale and must be regenerated before being trusted.

5. **Report.** Output two things only:
   - An **orphaned/one-only test table**: file path → status (`one-only:
     local-only` / `one-only: CI-only` / `orphaned`) → suggested exact wiring
     fix (e.g. "add `test/foo.test.ts` to the `test:integration` glob in
     `package.json`" or "add a step to `.github/workflows/ci.yml`").
   - A **coverage verdict**: fresh/stale, with the stale reasons (mtime gap,
     and/or list of named files that no longer exist).

   This skill only flags and suggests — it does not edit `package.json`,
   workflow YAML, or the coverage report itself.

## Model tiering

Entirely **haiku-tier**: static file enumeration, glob/pattern parsing, mtime
comparison, and existence checks. No code execution, no judgment calls about
test quality or shippability.
