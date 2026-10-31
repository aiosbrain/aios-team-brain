# AIO-1167 R51 — Fable delta review of Note A count correction

Perform one fresh independent READ-ONLY Fable 5.1 review using subscription-authenticated Claude. Do not edit/write, run shell commands/tests/builds, commit/push, contact external services, or start subagents. No arbitrary output cap: inspect the complete relevant delta, direct callers and counting contract before summarizing.

## Frozen exact snapshot

- Base `5ecd2989e21fded915b41b508477bb267aaec06d`. Source paths 42; tracked patch SHA-256 `a7d20559ee27e01f665a622069042f3fab6c218f914cf5cc559331e07bcdf773`; untracked source archive SHA-256 `d554a5aea12094048b6d1df881dc85f79b768a5622adac5c79e05ef3898abe11`; manifest SHA-256 `dff71f20a16aa67487b09648dbc0537ea1be33aa61cff6c3ff40609aaf31a959`.
- Exact review files are `review-source.diff`, `changed-files.txt`, `manifest.json`, `untracked-source.tar.gz`, `r51-acceptance-mapping.md`, and `verification.md` in this bundle.
- Prior Fable-reviewed R51 patch SHA-256 `c09abf59b6a6d30993088321da612e1d384365ffad8d87bcb100cac2b715dfbe`. Exactly two paths changed: `ingestion/aios_ingest/gdrive_sync.py` and `ingestion/tests/test_flush_authority_outcome.py`. The other 40 of 42 paths are byte-identical; prior Fable coverage is reusable for those. See `delta-since-r51-fable.json`.
- Astra disposition: Note A ACCEPT/FIX (double-counted failed run); Note B ACCEPT/DEFER (unknown backlog after authority loss follows existing classification and safety exit). Read `astra-r51-fable-delta-low-adjudication.md` and `previous-fable-review.md`.

## Delta review focus

Inspect all current hunks and the complete helper/callers in `gdrive_sync.py`, plus both changed paths and the regressions. Confirm the `cause` parameter is supplied only by callers that already charged this run; `charge=cause is None` preserves exactly one failure charge without globally suppressing a required authority-failure count. Confirm authority/unpublished categories remain once each, original cause/progress are preserved, no exception text is exposed, no later provider/checkpoint action is introduced, and no-cause/drain behavior remain unchanged. Verify actual binding-catch regression for both `stale_execution` and `connection_unavailable`, including retained earlier named minimum. Evaluate whether any new scenario is under-counted or double-counted. Note B is intentionally unchanged/deferred; do not reopen it unless the new code materially changes its safety/contract.

Coordinator evidence (not proof): focused test **10 passed in 0.46s**; full sidecar **959 passed, 28 skipped** with one existing deprecation warning; `git diff --check HEAD` passed.

## Required response

Lead with verdict: `changes required`, `hold`, or `no actionable findings in reviewed scope`. Findings first, with severity, exact current file/line, scenario, expected/actual, impact, caller/contract evidence, and concrete regression. Separate correctness findings from optional diagnostics/rollout gates. Provide a FULL/PARTIAL/UNREAD ledger for each changed path and state that other 40 paths' prior coverage is reusable based on supplied hash comparison. If a material interaction cannot be verified on this snapshot, say HOLD. No whole-branch, merge or release-readiness claim.
