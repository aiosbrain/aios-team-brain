# AIO-1167 R51 — Astra MEDIUM adjudication of Fable Lows

- Snapshot: base `5ecd2989e21fded915b41b508477bb267aaec06d`; source patch SHA-256 `8a1afd7dbc75b495e9c1086a29ce11fbd4a7474eb876e3f0e964b569bf2af27b`.
- Input: fresh Fable 5.1 report `r51-fable-review-report.md`, plus accepted spec, R50 adjudication and R51 acceptance map.
- Verdict: both items are confirmed Low; fix both in one bounded writer slice. Neither establishes a High/Medium defect or review coverage HOLD. The Fable no-High/Medium verdict remains valid for that exact snapshot. After fixes and coordinator verification, obtain delta review and blind Astra HIGH / Sol HIGH reviews.

## L1 — reporting at orderly-return checkpoint flush

Confirmed Low, diagnostics only. Standing-hold construction at `gdrive_sync.py:1367–1378` builds a summary with `skipped=1` and hold category; terminal authority failures from `_publish_restriction_evidence` (`:392–394`) pass through `_flush_restriction_evidence` (`:422–425`) and re-raise when `cause is None`. Callers include `:1426`, `:1527`, `:1814` and `_open_account_hold` (`:457`). Scheduler (`scheduler.py:157–173`) and manual reporting (`:315–322`) can then replace the meaningful outcome with `coordinator_error`, `failed=1`, backlog unknown. The local SQLite hold, obligations and lease cleanup remain; this does not authorize stale publication or erase provider state. Scheduled reporting may also suppress after an Admin pause/disconnect re-read.

Fix now while preserving terminal stop semantics. Retain the hold/progress summary plus authority code and applicable unpublished categories; do not resume provider work or expose exception text. Preserve an existing cause and add a distinct flush authority code rather than replacing it. Handle the directly equivalent drain catch at `:1672–1674` without losing `closed.partial` or hold diagnostics. Let status follow existing summary classification rather than forcing every authority-loss case to `partial`.

Regression: standing local hold plus checkpoint refusal `stale_execution` and `connection_unavailable`; verify summary retains hold category, authority code and unpublished category once, local hold persists, no provider reads or later checkpoint follow, lease cleans up, and scheduled/manual reports do not become generic coordinator failure. Preserve paused/disconnected suppression. Include accumulated-progress/end-flush control.

## L2 — local BrainClient delay provenance

Confirmed Low behavioral provenance violation. `BrainDeferred` only carries `not_before` (`brain_client.py:93–103`). `_backoff` (`:353–357`) and `_timeout_backoff` (`:364–369`) put both server Retry-After and local exponential/jitter fallback in that field; checkpoint retry (`:609–622`) combines those sources too. Consumers `_record_sink_failure` (`gdrive_sync.py:3505–3511`) pass `external=True` by default, and accepted-content checkpoint handling stores the time as a minimum (`:3182–3186`). `StateStore.fail_work` retains the minimum monotonically and exhausted-work rearm preserves it (`state.py:1657–1678`, `1706–1722`). A local sidecar delay is not brain-named.

Fix now: represent provider minimum separately from combined local eligibility; propagate only the provider-supplied minimum into persistent external-minimum state. Keep local fallback/jitter as ordinary `not_before`; preserve genuine server minima and existing unknown legacy minima. Do not treat a valid zero Retry-After as absent. Preserve the checkpoint uncertainty latch, `failure=False` after accepted content, and all acknowledgment obligations.

Regression: BrainClient 503 without header and malformed-header fallback at the exhausting sink-failure/rearm path must leave external minimum absent and eligible immediately. Controls: positive and zero valid Retry-After, timeout fallback, existing minimum preservation, and non-exhausted work retaining its normal backoff. For accepted-content checkpoint deferral, local-only minimum remains absent, failure budget unchanged, obligation retained and uncertainty latch honored; do not require immediate rearm eligibility for that non-exhausted obligation.

## Scope and remaining gates

R49 F6 stays deferred until before unattended rollout: bounded repeated deterministic checkpoint refusal, actionable reporting, retained acknowledgment obligations, idempotent replay and recovery. These corrections do not close F6. Keep H2, M-b/M-c/M-d, live Google certification/soak, opt-in/runner proof, canary and rollback open. No merge, deployment or readiness claim.

Astra report returned in the bounded read-only GPT-6 Astra MEDIUM adjudication; it made no edits or tests.
