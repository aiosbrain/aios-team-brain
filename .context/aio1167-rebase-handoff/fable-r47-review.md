Review complete. Below are the findings and verdict for the R47 snapshot.

## Verdict

Not ready to certify. The snapshot is architecturally sound and the R47 corrections (F1, F3, F5, F6, F8) are implemented as described and covered by the six untracked tests. Two confirmed defects remain open, and the live sandbox certification gate has no evidence in this bundle, so release acceptance cannot be claimed.

What I verified by reading: the coordinator in `ingestion/aios_ingest/gdrive_sync.py`, `brain_client.py`, `state.py`, `connector_state.py`, the Drive source and Docs extractor, watch lifecycle and renewal, webhook receiver, scheduler, selections; on the brain side `gdrive-authority.ts`, `gdrive-oauth.ts`, grant policy, OAuth state and routes, `member-identities.ts`, `resolve.ts`, `provider-sync.ts`, `discovery-conflicts.ts`, the ingest owner and Drive commit locks, source reconciliation and claims, memberships and units, authorization epoch, timeline cache and builder, identity repair and reattribution, run ledger and status, admin actions, migrations and the admin panel. I sampled test suites by title and read the six untracked tests in full. I did not run tests.

## Confirmed defects

**D1. Medium. AC-05, AC-07. A selected root that is hard-deleted or made inaccessible after binding wedges its stream during any rescan.**
`_bind_selected_roots` handles a 404 only for a root that has never been bound (it records `unresolved`). Once bound, `_enumerate_baseline` reads the root again with no handling: a file root goes through `source._metadata` at `ingestion/aios_ingest/gdrive_sync.py:2152`, and a folder root is listed at `gdrive_sync.py:2228` after `_observe_root` returns `absent` and `settle_root` marks it bound. Google answers 404 for both, so the exception reaches the generic handler at `gdrive_sync.py:1654` and becomes a per-run `provider_read` failure with the diagnostic `baseline: HttpError`.
Triggering scenario: a selected folder is permanently deleted in Drive. The change log reports it removed, the tombstone branch seeds a rescan whose `rescan_roots` includes the deleted root itself, and every subsequent run fails the rescan. The page cannot retire, the cursor cannot advance, the stream never completes, and only a scope change recovers it. The same happens to a bound file root deleted before a 410-driven controlled rescan or a recovery restart.
Expected: a positively identified 404 on a bound root is removal evidence for that root. The root should be recorded as gone, excluded from enumeration, and its descendants retired after the complete snapshot. Actual: permanent `provider_read` stall with no actionable diagnostic.
Why tests miss it: the `_DriveWorld` harness answers an unknown folder listing with an empty page rather than 404, and no test deletes a bound file root before a rescan.
Regression: in `test_gdrive_upgrade.py`, after a baseline, hard-delete a bound folder root so both metadata and listing raise 404, run through the tombstone-seeded rescan, and assert the cursor advances, the snapshot publishes, descendants are reconciled, and no `provider_read` is reported. Add the file-root variant through a 410 rescan.

**D2. Medium. AC-04. A provider `Retry-After` is honoured without any upper bound, and the resulting account hold is monotonic and has no operator escape.**
`GoogleDriveSource._retry_after` at `ingestion/aios_ingest/sources/gdrive.py:503` returns any non-negative value. `_provider_call` turns it into `ProviderDeferred.not_before`, `_account_hold` records it, and `StateStore.hold_connection` keeps the later of two instants. `_fail_work` applies the same unbounded value to per-document `not_before`. The brain client caps the same header at 3600 seconds in `brain_client.py:843`; the Google path does not.
Triggering scenario: one malformed or hostile `Retry-After` of a very large value on any Drive call. The hold is published to the brain, adopted by every sidecar via `_adopt_remote_account_hold`, and refuses every provider read before the roots are even read. Run now and Retry do not clear a hold; `rearm_exhausted` only re-arms work. Recovery requires a scope change.
Expected: a bounded wait, with values beyond the bound treated as a conservative default. Actual: an effectively permanent connection stall with a `rate_limited` diagnostic.
Regression: a unit test in `test_gdrive_upgrade.py` asserting that `Retry-After: 99999999` yields a `not_before` within the cap, and a coordinator test asserting the hold expires within that cap.

## Risks, coverage gaps and limits

Uncertain risks, not confirmed defects:

- **Provider 5xx and timeouts spend the document retry budget.** `_drain_pending` charges `provider_unavailable` and `provider_timeout` through `_fail_work`; eight failures exhaust the obligation. A multi-hour Google outage exhausts every pending document, and under the F4 gate the connection then withholds absence reconciliation until an Admin re-arms. This follows the adjudicated policy but means an outage converts into manual work.
- **Reconnect and credential rotation reset durable progress.** The `sync_gdrive_connection_authority` trigger clears `progress` whenever `secret_ciphertext` changes, including a reconnect of the same account. Content identity survives through `source_item_mappings`, so AC-05 holds, but every reconnect forces a full re-baseline and discards the renewal-owned `watches` section, leaving live Google channels unstoppable until they expire. Notifications from them are rejected, so this fails closed.
- **Identity discovery fences attributed reads.** Each new `permission:` link from a push bumps the team identity revision, which sets the common repair to pending and makes `authorizationEpoch` throw until the repair completes. During an initial backfill with many collaborators the Timeline and arcs can be unavailable repeatedly. This is the specified fail-visible behaviour, but the availability cost during baselines is real.
- **Unbounded contribution ledger.** `mergeGdriveContributions` retains one row per revision ever observed, and the sidecar re-sends the full revision list on every push. No frontmatter size cap exists below the 5.4 MB request ceiling. Long-lived documents grow payload and storage without bound.
- **Blocking provider calls on the event loop.** `run_gdrive_stream` makes synchronous Google calls for up to the 55-second run budget inside an async job, delaying the hint drain, manual queue and renewal sweep. The renewal module offloads to a thread pool; the coordinator does not.
- **Error text sanitization.** `saveGoogleDrivePickerSelection` returns any `Error.message` to the browser, not only authority errors. No token path reaches it, but database text could.
- **Dead code.** `GoogleDocsExtractor` in `sources/gdrive.py` is unused; extraction goes through `gdrive_docs.extract_google_doc`. It can mislead future readers about which contract is live.

Test coverage gaps against the acceptance matrix:

- No test for a bound root deleted within a generation during rescan or recovery, as described in D1.
- No test bounding a provider `Retry-After` or the duration of an account hold.
- No test that a provider outage long enough to exhaust retries is distinguishable in Admin diagnostics from a document-specific failure.
- Live certification: the bundle contains no sandbox manifest, run IDs, soak records or screenshots. By the spec this leaves certification blocked regardless of automated results.

Areas I could not inspect or did not inspect in depth:

- The full 90,000-line diff was not read line by line. I read the core connector, authority, identity, ingest, reconciliation, cache and timeline modules in full and sampled test suites by test title.
- Not read in depth: `lib/graph/arcs.ts`, `arc-corrections.ts`, `arc-fusion.ts`, `provenance-read.ts`, `lib/db/pg/tx.ts` and `pool.ts`, the React components other than the Drive panel and conflicts table, scripts, and the documentation changes. Epoch checks in `arc-cache.ts` were confirmed by grep only.
- No tests were executed and no database or live Google account was available, so persistence, lock ordering under contention and the real-Postgres suites are assessed from source only.
