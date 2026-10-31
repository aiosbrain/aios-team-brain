# AIO-1167 R45: M8, L8 and acceptance reconciliation

This phase follows the H1/M5/M6/L2 correction checkpoint `3e31ab7d80c0632aac2f1881e9e7f9cebbf1a67c`. It is not yet independently reviewed.

## M8: real stream access refusal

New `ingestion/tests/test_stream_access_real_routine.py` exercises the real coordinator, stream routine and Google Drive error classification, with only provider transport stubbed. Coverage includes:

- Non-quota 403/404 with denied stream first and second: denied cursor/membership retained, sibling stream reaches its terminal token, run is partial, no complete-snapshot reconciliation occurs, and denied stream recovers later.
- Quota 403 rate-limit reasons and 429: both streams held, later stream not read, no cursor movement.
- Google 401 and brain-authority refusal: stop the run before another stream; not classified as a single-stream access refusal.

This exposed a narrow product bug: Google 401 (`provider_unauthorized`) did not stop the coordinator from attempting other streams with the same rejected account credential. `ingestion/aios_ingest/gdrive_sync.py` adds `_RUN_TERMINAL_CODES` for the between-stream terminal check, without changing `_is_terminal_authority` used by sink/checkpoint classification. The 401 test fails if this code is removed. This product change must receive fresh review.

## L8: cache path proof

- `lib/dashboard/timeline-cache.ts` adds optional `TimelineReadHooks.onServed(origin)` for `memory`, `persisted`, or `cold`; it is only passed by the test reader and does not alter serving or writes.
- `test/datamechanics/processes/timeline-reader.ts` returns the observed origin.
- `test/datamechanics/gdrive-revocation-multi-process.datamechanics.test.ts` proves a warm in-memory hit from process B and a persisted-row hit from fresh process C before revocation. After revocation, C rebuilds without stale text and B does not serve it from memory. Surviving audience and blocked-build assertions remain.
- Writer mutation checks reportedly fail if stale memory or stale persisted rows are served across an authorization epoch.

## Acceptance gap reconciliation

The writer compared the adjudication's explicit list against actual assertions and added only missing evidence:

- Stored OAuth state expiry: unit and new real-Postgres test `test/datamechanics/gdrive-oauth-state-expiry.datamechanics.test.ts`; expired state consumes no nonce; fresh state redeems once.
- Real route handling of Google's empty-body notification: two route tests in `ingestion/tests/test_notification_admission.py` using `TestClient`.
- UTC day grouping across a local-midnight boundary: `test/gdrive-timeline.test.ts` through the real evidence builder/grouping.
- Bound connector/ordinary team/external/other-connection/wrong-team/revoked-key metadata boundary over HTTP with no secrets in responses: new `test/http/gdrive-integrations-metadata.http.test.ts`.

Items with existing test/assertion evidence were mapped in the writer's report: empty/denied/partial selection; OAuth one-time/browser binding; notification coalescing and sync handshake; budget-two and exact boundary; selected-scope restore; non-authorship; UTC/DST normalization; metadata boundary over real Postgres.

## Coordinator verification

- Python `test_stream_access_real_routine.py` plus `test_notification_admission.py` — 29 passed (one existing Starlette/httpx deprecation warning).
- `npm run typecheck` — exit 0.
- ESLint on all changed TypeScript files in this phase — exit 0.
- `npx vitest run test/gdrive-oauth-state.test.ts test/gdrive-timeline.test.ts` — 2 files, 28 passed.
- Isolated real-Postgres `gdrive-revocation-multi-process` and `gdrive-oauth-state-expiry` suites — 2 files, 3 passed.

Writer-reported broader results:

- Python suite — 721 passed, 28 skipped.
- `npx tsc --noEmit` and changed-TypeScript ESLint — clean.
- Vitest on Drive, timeline, timeline payload and entry-surface guards — 22 files, 617 passed.
- Isolated data-mechanics on cache, access-enforce-timeline, attribution-correction-epoch, multi-process revocation and OAuth-state expiry — 5 files, 27 passed.
- After a fresh `npm run build`, metadata HTTP test plus broker-success and gdrive-authority — 3 files, 12 passed.
- `git diff --check` — clean.

## Still open

- **Separate sidecar operating-system processes:** accepted spec requires two Python processes with separate state files and stale authority rejection. Existing tests use separate `StateStore`s in one process; this explicit acceptance item remains unproven and should be added next.
- **Admin conflict presentation:** linked, missing, deactivated and unresolved states are shown in the inspected Admin surfaces, but automatic `identity.discovery_conflict` is audit-only and read nowhere. The writer made no UI change because this is a product/spec decision. Route the narrow choice to Astra for adjudication and continue independent sidecar test work.
- **H1 pre-stream cases:** limits during start-token capture and root binding still fail the run without persisting an account hold; this remains outside the adjudicated H1 scope.
- No final/independent review covers the new R45 phase-two snapshot yet.
