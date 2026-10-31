# AIO-1167 R51 — adjudicated Low corrections

Resume only the existing sole Claude Opus 5.5 HIGH writer session `628402d5-a1c6-42b7-b736-e84358c1a749`. Do not start a second writer. The coordinator owns all tests, shell commands, review routing, checkpoints, pushes and handoff. Make only the two bounded fixes below and their necessary regressions/acceptance-map update. Do not run commands or tests, commit/push, or touch user/unrelated files, Claude memory, credentials, other tasks or rollout configuration.

Read the accepted spec `docs/design/google-docs-connector-upgrade.md`, `.context/aio1167-rebase-handoff/astra-r50-adjudication.md`, `.context/aio1167-rebase-handoff/astra-r51-low-adjudication.md`, `.context/aio1167-rebase-handoff/r51-acceptance-mapping.md`, and `.context/aio1167-rebase-handoff/r51-fable-review-report.md`. Current source-only base is `5ecd2989e21fded915b41b508477bb267aaec06d`; pre-correction patch SHA-256 is `8a1afd7dbc75b495e9c1086a29ce11fbd4a7474eb876e3f0e964b569bf2af27b` (40 paths). Fable verdict on that exact snapshot was no actionable High/Medium and no HOLD. Astra confirmed both Lows and requires these bounded fixes before final reviews.

## Correction A — preserve hold outcome on terminal checkpoint refusal

Relevant owners: `ingestion/aios_ingest/gdrive_sync.py` orderly-return flush (`_publish_restriction_evidence`, `_flush_restriction_evidence`) and its standing-hold, drain, no-stream, and end-of-run callers; scheduled/manual summary reporting in `scheduler.py`.

At orderly-return boundaries, terminal `stale_execution` or `connection_unavailable` from publishing unpublished hold evidence can currently re-raise when there is no earlier cause, replacing the meaningful `rate_limited`/hold/progress outcome with generic `coordinator_error`. Preserve the accumulated summary and report the authority code plus applicable unpublished categories. Preserve any existing cause and add a distinct flush authority code without replacing it. Do not expose exception text. Do not resume provider work, publish stale state, discard obligations, or change paused/disconnected suppression. Preserve `closed.partial` and hold diagnostics in the equivalent drain catch. Let status follow existing classification; do not force every authority-loss outcome to partial.

Add regressions for both terminal codes at standing-hold repair, plus an accumulated-progress/end-flush control. Assert local hold persistence, no provider reads and no later checkpoint after terminal refusal, lease cleanup, accurate scheduled/manual summaries without generic coordinator failure, and paused/disconnected suppression.

## Correction B — separate provider minimum from local BrainClient fallback

Relevant owners: `ingestion/aios_ingest/brain_client.py` `BrainDeferred`, push/checkpoint backoff and timeout fallback; `ingestion/aios_ingest/gdrive_sync.py` consumers; `ingestion/aios_ingest/state.py` minimum persistence/rearm behavior; targeted Python tests.

`BrainDeferred.not_before` currently combines server Retry-After with locally computed exponential/jitter fallback. Consumers can persist this as an external minimum, and exhausted-work rearm retains it. Add a distinct representation for a provider-supplied minimum while keeping combined local eligibility separate. Propagate only the brain-supplied minimum into persistent external-minimum state. Keep local fallback/jitter in ordinary `not_before`; preserve genuine server minima and unknown legacy minima. Valid zero Retry-After must remain distinguishable from no header. Preserve the checkpoint uncertainty latch, `failure=False` after accepted content, and all acknowledgment obligations. This does not implement deferred R49 F6.

Add regressions: 503 without Retry-After and malformed-header fallback on exhausting sink failure/rearm leave external minimum absent and become eligible immediately; controls for valid positive/zero Retry-After, timeout fallback, existing minimum preservation, and non-exhausted work retaining normal backoff. For accepted-content checkpoint deferral, local-only minimum stays absent, failure budget remains unchanged, obligation remains, and latch is honored; do not demand immediate rearm eligibility for that non-exhausted obligation.

Update the R51 acceptance mapping with exact new file/tests and mark only these two Low items resolved in the implementation. Keep R49 F6 explicitly deferred and all operational gates open. Return a concise change report and list every changed path. No tests/commands; coordinator will inspect and verify the resulting snapshot.
