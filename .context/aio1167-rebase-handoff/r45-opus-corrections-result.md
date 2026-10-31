# AIO-1167 R45 correction slice: H1, M5, M6, L2

Source checkpoint: `6920f9f3986755b978e9f2cac6907c2a84568526` (H1/M5/M6/L2 implementation). The focused regression files were completed after that checkpoint and are included in the follow-up handoff checkpoint. Based on source snapshot `8671684e2a34af66c826bf4e8956392a5bbe110f`; staging base `8df51664809cfc12740a39d0e98fdb9c8ad05ad8`.

## Changes

- **H1:** propagate account-wide provider Retry-After admission from baseline metadata/body/listing and change-page reads. Keep previously completed counts truthful, classify the run as rate-limited/partial, and hold all streams through restart until the wait expires. Single-stream 403/404 and authentication errors retain their existing behavior.
- **M5:** separate accepted content push from checkpoint acknowledgment. A checkpoint deferral retains owed progress and its wait without increasing document failures or exhausting work; it does not acknowledge or retire the page. Actual content-push failures still count.
- **M6:** distinguish the provider request deadline from the overall run budget. A successful response received after only the local run deadline is deferred without a provider-failure charge and no new work starts; a request/transport timeout remains a charged provider timeout.
- **L2:** share `assertGdrivePayloadBinding` between identity discovery and content commit. Reject mismatched or missing connection/source binding before identity reads/writes; preserve commit-time checks, the live execution fence and lock order.

## Regression coverage

- New `ingestion/tests/test_account_hold_phases.py`: real coordinator/stream routine with a two-stream account; quota responses at first metadata, Docs body, baseline listing and `changes.list`; no further provider call after the hold, both streams held, restart before expiry makes no calls, later recovery succeeds, and a non-quota 503 remains per-document failure.
- `ingestion/tests/test_drain_recovery.py`: ten checkpoint deferrals with state reopened between attempts; no failure/exhaustion, owed work and Retry-After persist, recovery acknowledges once. Late successful response is classified as `run_deadline`; request timeout remains `provider_timeout`; repeated local-budget deferral does not charge the document.
- `test/datamechanics/gdrive-identity-discovery-route.datamechanics.test.ts`: real items route rejects connection B, missing source ID and blank source ID under connection A with no identity, mapping, repair obligation or revision mutation; matching A links; stale execution, other-team and revoked-key controls refuse without mutation.
- `test/datamechanics/gdrive-identity-discovery.datamechanics.test.ts`: update direct test fixtures to supply the required payload binding.

## Verification

Writer-reported results from the Opus 5.5 HIGH turn:

- `.venv/bin/python -m pytest tests/test_account_hold_phases.py` — 5 passed.
- `.venv/bin/python -m pytest tests/test_drain_recovery.py` — 15 passed.
- `.venv/bin/python -m pytest tests -q -p no:randomly` — 709 passed, 28 skipped.
- `npm run typecheck` and ESLint for all changed TypeScript files — clean.
- `npx vitest run test/gdrive-*.test.ts test/guards/drive-common-writer-ownership.test.ts test/guards/identity-mutation-boundary.test.ts test/guards/context-hook-callsites.test.ts test/guards/integrations-tier-filter.test.ts test/items-route-*` — 25 files, 638 tests passed.
- Isolated data-mechanics run across discovery, discovery-route, authority and drive-common writer ownership — 4 files, 65 tests passed.
- `git diff --check` — clean.
- Mutation checks for H1 baseline/account hold, M5 checkpoint charging, M6 deadline classification/drain and L2 discovery binding each reproduced the corresponding regression failure before restoration.

Coordinator verification after the writer returned:

- Combined focused Python suites (`test_account_hold_phases.py`, `test_drain_recovery.py`) — 20 passed.
- `npm run typecheck` — exit 0.
- ESLint on `lib/integrations/gdrive-authority.ts`, `lib/integrations/gdrive-identity-discovery.ts`, `lib/ingest/index.ts` and the two changed identity-discovery data-mechanics tests — exit 0.
- Isolated real-Postgres discovery and route suites — 2 files, 10 tests passed. The unprivileged attempt was denied access to the host Docker socket; rerunning through the normal approval path succeeded.

## Still open

This completes only the H1/M5/M6/L2 correction slice. No independent delta review, final Astra review, or Sol review has occurred on this new snapshot. M8 real stream-routine 403/404/rotation/quota/auth coverage, L8 separate warm-memory/cold-process persisted-cache proof, and acceptance-gap reconciliation remain. H1 failures before stream admission (start-token capture/root binding) still fail the run without a persisted hold; that behavior was outside this adjudicated scope and was left unchanged.
