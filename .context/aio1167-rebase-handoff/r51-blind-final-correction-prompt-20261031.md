# AIO-1167 R51 blind-final corrections — sole Opus writer

You are the existing sole implementation writer: Claude Opus 5.5 at HIGH, using the already logged-in Claude.ai subscription session. Do not start a second writer, change providers, use API billing/credits, or delegate overlapping implementation.

Read first: `CURRENT.md`, `accepted-spec.md`, `r51-blind-final-adjudication-20261031.md`, and the two blind review reports. Inspect the live candidate and its affected callers/contracts. The frozen source base is `5ecd2989e21fded915b41b508477bb267aaec06d`. Astra accepted all five findings as fixes, but the legacy email-tombstone change overlaps the existing open PR #714, which also edits `lib/identity/member-identities.ts`. The coordinator has therefore held that single identity slice pending ownership confirmation. **Do not edit `member-identities.ts`, `gdrive-oauth.ts`, identity code/tests, or PR #714-owned behavior. Implement only the four independent ingestion restriction/watch corrections below.**

## 1. Let verified removal obligations proceed under a resource restriction — High

The current pending-action filter suppresses every action for a restricted ID. Make it action-aware so a confirmed `remove` obligation can reach the existing claim-aware removal/reconciliation owner without an unnecessary provider read. Keep upserts and restoration restricted. If a cross-stream move is ambiguous or requires a deferred metadata probe, retain the removal obligation and honor the active hold; do not use this change to permit early reads. Preserve other connections' valid claims and content visibility.

Add a discriminating regression: previously imported document, resource restriction active, then explicit trash/removal before expiry. Assert claim retirement/content suppression promptly, zero unnecessary restricted reads, overlap preservation, and no accidental restoration. Cover ambiguous cross-stream state remaining pending.

## 2. Preserve deferrals from cross-stream removal probes — Medium

`_document_loss_verified()` currently turns `ProviderDeferred` into `False`. Propagate a typed outcome to the removal drain. Quota responses use the existing account-stop/restriction publication path; resource-named waits persist a document restriction and keep the removal unresolved; local retry deadlines stop without creating provider holds. Never treat a deferred probe as positive survival or loss evidence, acknowledge removal, or retry before a named minimum. Preserve bounded fallback/backoff for invalid or missing `Retry-After` and truthful diagnostic categories. Coordinate this with issue 1; they remain distinct policy paths.

Add focused tests for 429, quota 403 and 503 Retry-After on both claimant and unreadable-peer probe paths. Assert account-wide stop versus resource-only isolation, durable state across restart, no premature probe or removal acknowledgment, and resumed reconciliation after expiry. Include local deadline and malformed-header controls.

## 3. Enforce account holds before watch provider calls — Medium

After verified account resolution and before watch creation, renewal, or cleanup provider operations, reuse the existing restriction owner to adopt acknowledged evidence and enforce local/remote standing account holds. Do not widen this into a new cross-connection quota authority. Preserve channel/watch evidence, cursors, local publication recovery, and same-account generation semantics; never adopt another credential's hold.

Add regressions for due creation and due cleanup while held, both retained and fresh local state: zero create/stop calls before expiry, old channel evidence/cursor unchanged, normal action after expiry, no cross-credential adoption, and same-account generation change not erasing a hold.

## 4. Retry publication of a standing service-account prerequisite restriction — Medium

On a fresh acquisition whose service-account identity prerequisite remains restricted, build the held summary and call the existing `_flush_restriction_evidence()` exactly once before returning. Reuse its authority-loss, uncertainty-latch and unpublished-diagnostic semantics. Do not issue an identity provider read while the restriction is active.

Test: initial restriction publication fails; a later fresh acquisition with retained local evidence retries publication before expiry; a subsequently fresh state file honors it. Repeated publication failure remains explicitly `document_restriction_unpublished`; authority refusal and uncertain acknowledgment retain evidence and cause no unauthorized calls.

## Constraints and completion evidence

- Do not alter the accepted spec or review reports. Do not edit the held identity-tombstone slice; do not resolve ownership by choosing an entire file from either branch.
- Preserve one source writer, authentication/quota protections, existing typed authority paths, durable local checkpoints, and remote backup cadence. No merge or deployment.
- Run meaningful focused regressions for all four fixes, then broader affected ingestion/watch suites as warranted by the changed dependencies. Capture exact commands/results, inspect every changed caller and `git diff --check`, and checkpoint only these task-owned edits. Do not weaken assertions to pass.
- Report changed paths, behavioral summary, focused and broader verification, unresolved test/production limitations, and any needed additional finding. The coordinator owns review routing, checkpoints/pushes and adjudication; do not duplicate those coordination steps.
