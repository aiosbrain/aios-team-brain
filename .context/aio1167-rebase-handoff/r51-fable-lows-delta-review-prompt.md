# AIO-1167 R51 — Fable 5.1 delta review of Astra-adjudicated Low fixes

Perform a fresh independent READ-ONLY Fable 5.1 review using the subscription-authenticated Claude session. Do not edit or write files, run shell commands/tests/builds, commit/push, contact external services, or start subagents. No arbitrary output cap; inspect the full relevant delta and callers before summarizing.

## Frozen exact snapshot

- Base: `5ecd2989e21fded915b41b508477bb267aaec06d`.
- Full source-only patch SHA-256: `c09abf59b6a6d30993088321da612e1d384365ffad8d87bcb100cac2b715dfbe` (42 paths; `.context/` excluded).
- Manifest SHA-256: `ec8237e7050d579da03ef0594600cb6b46aff6446164197c5b5498df93d67e03`.
- Exact patch and full 42-path manifest: `.context/aio1167-review-bundles/r51-lowfix-final-20261031T164048_981913Z/review-source.diff`, `changed-files.txt`, `manifest.json`, `untracked-source.tar.gz`.
- Prior Fable snapshot patch SHA-256: `8a1afd7dbc75b495e9c1086a29ce11fbd4a7474eb876e3f0e964b569bf2af27b`. The coordinator's content-hash comparison shows precisely four paths changed since it: `ingestion/aios_ingest/brain_client.py`, `ingestion/aios_ingest/gdrive_sync.py`, new `ingestion/tests/test_brain_minimum_provenance.py`, and new `ingestion/tests/test_flush_authority_outcome.py`. The other 38 source/test paths have identical SHA-256 values to that reviewed snapshot. Comparison is `.context/aio1167-review-bundles/r51-lowfix-final-20261031T164048_981913Z/delta-since-r51-fable.json`.
- Read `.context/aio1167-rebase-handoff/astra-r51-low-adjudication.md`, `.context/aio1167-rebase-handoff/r51-acceptance-mapping.md`, coordinator verification bundle's `verification.md`, and the previous Fable report at `.context/aio1167-review-bundles/r51-lowfix-final-20261031T164048_981913Z/previous-fable-review.md`. Prior Fable verdict was no actionable High/Medium/no HOLD on its exact snapshot; its 40-path coverage ledger remains valid for the 38 byte-identical paths.

## Delta review scope

Independently inspect both full current production files, all four listed delta paths, the complete current diff hunks, and relevant callers/consumers. Confirm the 38 unchanged paths really have no content changes according to the coordinator comparison; do not spend time re-reviewing unrelated unchanged regions unless a new dependency requires it.

1. **L1, terminal authority refusal at orderly-return flush:** verify a `stale_execution` or `connection_unavailable` checkpoint refusal retains the existing hold/progress outcome, adds authority/unpublished diagnostics once, preserves any existing cause, never reports exception text, performs no later provider reads/checkpoints or stale publication, retains the local journal/lease cleanup, and leaves scheduler paused/disconnected suppression intact. Confirm the equivalent drain catch retains `closed.partial` and hold diagnostics. Examine whether status follows the existing outcome classification. Use the new `test_flush_authority_outcome.py` as regression evidence, then trace code/callers.
2. **L2, provider Retry-After provenance:** `BrainDeferred.provider_not_before` must be only a valid brain-named minimum, including zero; local fallback/jitter and timeout remain ordinary combined `not_before`; `not_before` must be at or after any provider minimum. Verify sink failure persistence/exhaustion/rearm stores only provider minima, a valid positive minimum survives, a valid zero is not mistaken for absence, prior minima are monotonic, non-exhausted backoff remains, and accepted-content checkpoint deferral preserves the acknowledgment obligation and uncertainty latch without spending the failure budget. Inspect all `BrainDeferred` constructors and consumers, not tests alone. R49 F6 repeated deterministic checkpoint refusal remains deferred and is not claimed solved.

The coordinator reports focused six-module tests **78 passed in 2.31s**, full sidecar **957 passed, 28 skipped in 22.67s** (one existing Starlette/httpx deprecation warning), and `git diff --check HEAD` passed. Treat these as coordinator evidence, not as proof of correctness.

## Required response

Return a clear verdict (`changes required`, `hold`, or `no actionable findings in the reviewed scope`). List findings first with severity, exact current file/line, triggering scenario, expected versus actual behavior, impact, caller/contract evidence, and concrete regression. Separate correctness findings from rollout gates and speculative risks. Provide a four-path delta coverage ledger marked FULL/PARTIAL/UNREAD; state whether the prior 38-path coverage remains reusable based on the supplied content-hash comparison. If a material interaction cannot be verified on this exact snapshot, say HOLD and list it. Make no whole-branch, merge or release-readiness claim.
