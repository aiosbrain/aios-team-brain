# AIO-1167 R49 — adjudicated retry/recovery corrections

Continue in the existing sole writer session: Claude Opus 5.5 HIGH, session `628402d5-a1c6-42b7-b736-e84358c1a749`. Do not fork the session, delegate another writer, or commit/push. The coordinator owns tests beyond your slice, independent verification, checkpoints, pushes and handoffs. Use Claude.ai subscription authentication only; no API key or credits.

Read the concise current handoff and the exact decision before editing:

- `.context/aio1167-rebase-handoff/CURRENT.md`
- `.context/aio1167-rebase-handoff/astra-r48-adjudication.md`
- `.context/aio1167-rebase-handoff/fable-r48-review.md`
- `.context/aio1167-rebase-handoff/accepted-spec.md`
- `.context/aio1167-rebase-handoff/astra-r47-adjudication.md`

Astra adjudicated exact R48 source snapshot `333bf6a798d75db03256ea9c17fc61f8a011f18b` against R47 `151fb88e245ba380acdf9d734845d54aa7ae5bb9`, staging base `8df51664809cfc12740a39d0e98fdb9c8ad05ad8`. Read `astra-r48-adjudication.md` as binding scope. The source worktree already contains your R48 changes; do not overwrite user or coordinator files.

## Authorized correction scope

Implement the following bounded corrections in existing coordinator/state/progress owners, with focused regressions and architecture/acceptance updates:

1. **F1, document provider restriction ownership.** A document's valid `Retry-After` minimum must survive ordinary Run now/Retry, exhaustion rearm, a newer observation, restart, controlled rescan, and fresh local-state reconstruction. Separate the provider restriction from attempt/exhaustion bookkeeping. Carry it in the existing acknowledged, brain-fenced progress protocol and restore it before any provider read of the affected resource. Merge restrictions monotonically; key them by verified connection/account and stable provider resource with generation/context checks. Preserve independent-document progress. An uncertain checkpoint is not acknowledgment: keep local evidence, prevent affected publication/read from proceeding until authority is reacquired, and report durability uncertainty truthfully. Do not turn a per-document 503 into an account-wide hold.
2. **F2, bound-root diagnostics/admission.** In `absence_withheld`, settle only a positively verified present root. A duplicate/confirmed-absent observation must preserve root-unavailable evidence and all existing claim/absence gates. Preserve malformed and unrepresentable Retry-After diagnostics on this path. Route quota `ProviderDeferred` through the existing account-hold owner, stopping further account calls while preserving the unresolved page and withholding absence. Do not route nonquota deferrals as account holds.
3. **F3, verified file-root restoration.** Clear stale unavailable detail only on current, fenced evidence for the same selected stable file ID: current account/generation and live execution gate, fresh metadata proving readable, nontrashed supported content in the bound drive, current work observation/membership, no unresolved relocation, and successful extraction/accepted ingestion. A change-log hint or metadata visibility alone must not clear the detail or mark the run current.
4. Address Astra F6 only as specified: add one focused real-Postgres overlap/claim assertion only if existing coverage fails to exercise the D1 complete-snapshot path; add real `_provider_call` quota-versus-nonquota coverage for the affected root path; defer removing unused `_retry_after` unless required for correctness.
5. Update the accepted-test mapping and `docs/ARCHITECTURE.md` to describe the actual restriction owner, acknowledgment/recovery boundary, exhaustion semantics and retained diagnostic behavior. No new Admin override/UI/API surface, no shortening/capping valid delays, no broad queue redesign.

## Required regressions

- Seven failures, then an eighth provider-call 503 with a valid long Retry-After; repeated Run now/Retry causes no affected-resource provider read, push or completion before expiry.
- Repeat for the unrepresentable fail-closed sentinel.
- Reopen the same SQLite file, and separately reconstruct into a fresh file from acknowledged progress; neither permits early access.
- A duplicate/new observation and controlled rescan retain the minimum; unrelated documents still progress.
- After a representable deadline passes, rearmed work completes normally. Superseded stale upsert cannot restore content.
- Lost checkpoint acknowledgment and stale generation/revision cannot erase newer restriction evidence or manufacture completion.
- Duplicate root tombstone preserves unavailable detail; malformed/unrepresentable headers retain diagnostics; quota 403/429 stops sibling-stream account calls while nonquota errors remain stream-scoped.
- File-root restoration through change log clears detail only after accepted extraction; stale hint, changed drive, failed access and superseded work do not.
- Preserve an existing real-Postgres connection-claim overlap assertion; add one focused case only if the adjudication's path map shows a genuine gap.

Preserve all adjudicated invariants: only a previously bound root's own verified 404 supplies D1 loss evidence; direct/overlapping roots and other connection claims survive; failed/exhausted/unknown/deferred owed outcomes withhold scope-wide absence; exhaustion is never completion; valid provider minima are not shortened; the year-9999 sentinel is fail-closed and not an ordinary expiring promise; generation, lease, observation revision and progress-revision fences remain authoritative; account holds remain monotonic. Do not create an implicit override through queue replacement, rearm or rescan.

Run meaningful tests for touched paths and report exact commands/results, changed files, remaining limitations and the sanitized diff hash. Do not claim overall readiness. Stop after this bounded slice returns; coordinator independently verifies and checkpoints before requesting fresh reviews.
