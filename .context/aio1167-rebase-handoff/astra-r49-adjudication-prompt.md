# AIO-1167 R49 — adjudicate fresh Fable findings

You are the assigned GPT-6 Astra decision owner. Adjudicate the fresh read-only Fable 5.1 report for the exact R49 snapshot. Do not implement, edit files, or run tests. Treat Fable's findings as claims to verify against the current code and accepted product behavior, not as decisions.

Snapshot identity: feature `HEAD` `5ecd2989e21fded915b41b508477bb267aaec06d`; tracked source diff outside `.context/` SHA-256 `ae1a7e04c34fd24c668c17002fc25ff5f9d1e088b61865bab52bedbf3d69fb93`; complete source-and-tests patch SHA-256 `d7af06597815133665e4859c5cdd5881bee2059fa34ee705e3f62194c4b2448d`. Fable 5.1 first-party session `ee707864-20b4-4bbc-a45f-69e03b6714a8` completed successfully on this snapshot. Curated report: `.context/aio1167-rebase-handoff/r49-fable-review-report.md` (SHA-256 `a810e01f585c1c686fabc53fcfa6acca5b40989b49ebaf8cbb1d83f33896c180`).

Read the accepted specification, Astra R48 adjudication, R49 writer prompt, the report, and the cited current source/test files. Independently verify each finding and inspect the ownership, generation, retry/recovery, fencing and progress paths needed to decide it. The complete diff and all 12 added tests are available in `.context/aio1167-rebase-handoff/r49-fable-review.diff`.

Adjudicate findings 1–7 individually as **accepted**, **rejected with evidence**, **partially accepted**, or **deferred with a specific gate**. For each, give the verified trigger and code evidence, its relationship to the accepted spec/R48 decision, and the exact next action. For accepted changes, define bounded correction criteria and required regressions; do not broaden implementation beyond demonstrated needs. Resolve any contradiction between the R48 table's generation/context validation and its explicit prohibition on using scope changes as an implicit override.

In particular, decide:
- Whether document restrictions and account holds must survive selection-generation changes, and identify their canonical durable owner without permitting scope edits to clear provider minima.
- Whether Admin rearm should reset only attempts or also clear the local exponential-backoff component when no provider restriction remains.
- Which pre-stream root/provider deferrals are truly account-wide quota/outage holds versus stream/document-scoped outcomes, including 503 with Retry-After.
- How to preserve independent document progress when a restricted selected file root cannot be read during rescan or fresh-state recovery, without inferring absence.
- Whether the tombstone/conflict ordering, permanent checkpoint-refusal retry, and diagnostic gaps belong in this slice or a clearly bounded follow-up.
- Which unrun TypeScript data-mechanics checks and coordinator acceptance checks are required before another review.

Return a complete adjudication with an overall decision, a seven-row decision table, evidence and exact writer scope if changes are required, the minimum meaningful verification set, and remaining rollout limitations. Keep it focused, but do not omit a material finding or necessary reasoning. Do not claim readiness for publication or deployment.
