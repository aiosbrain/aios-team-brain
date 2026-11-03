# AIO-1167 final candidate review — `97b7bc92` against base `5ecd2989`

## Verdict: CLEAN

No confirmed defect was found in the source candidate. Four low-severity observations are recorded below as design questions or diagnostics gaps, with suggested narrowings and regressions. None blocks acceptance of the automated implementation gate. Live certification remains a separate, unevidenced gate per the accepted specification.

## Inspected scope and evidence

- Read in full: `accepted-spec.md`, `AGENTS.md`, `manifest.json` (70 paths), `verification.md`, and `full.diff` (about 16,200 lines) in the review bundle. The bundle's `full.diff` covers all 70 manifest paths. I could not recompute SHA-256 values without a shell, so hash/size claims in the manifest are taken as stated.
- Every production hunk was read: `app/api/auth/gdrive/callback/route.ts`, both Admin action files, `identity-conflicts.tsx`, `brain_client.py`, `connector_state.py`, `gdrive_sync.py`, `sources/gdrive.py`, `sources/gdrive_watch.py`, `state.py`, `watch_lifecycle.py`, `watch_renewal.py`, the seven `lib/` TypeScript files, the migration, and `schema.sql`. The `docs/ARCHITECTURE.md` hunk was read and matches the code.
- Working-tree cross-checks of unchanged shared contracts the patch depends on: the brain checkpoint endpoint's identical-replay acknowledgment (`lib/integrations/gdrive-authority.ts:897-922`), `gdrive-grant-policy.ts`, `resolve-authors.ts` resolver path, `identity-repair.ts` ledger update, `member-identities.ts` remove/discover paths, `authority.ts` mutation boundary, `repair-eligibility.ts` provenance predicate, the removal drain and change-classification loop in `gdrive_sync.py`, pending-work supersession in `state.py`, and the full trigger body in `schema.sql`.
- Test diffs: inventoried all 230 added Python tests and 60 added TypeScript cases by name; read in full the hunks that modify pre-existing tests (`test_drain_recovery.py`, `test_gdrive_poll_reporting.py`, `test_gdrive_upgrade.py`, `test_watch_lifecycle.py`, the four TS datamechanics edits) and the new grant-policy, audience-claims, authority/migration, snapshot-overlap, and queue-bound tests.
- No execution. The verification record's counts (1,075 Python passed, 137 identity/authority TS passed at the predecessor commit with no later TS production change) are reported claims, not something I verified.

## Acceptance-criterion status for this patch

| ID | Status | Basis in this candidate |
| -- | -- | -- |
| AC-01 Connect/select/authorize | Covered, pass | Admin test, Picker verification and manual-root verification now refresh through one owner held to the broker's stored grant ceiling before any Drive read; refusals are sanitized `GdriveAuthorityError` text with no token content. Callback reports per-identity outcomes without credentials. |
| AC-02 Complete content | Not touched by this patch | No extraction code in the diff. |
| AC-03 Resumable baseline/changes | Covered, pass | Checkpoint uncertainty latch on lost acknowledgments or `stale_progress`; identical-payload replay is acknowledged by the brain's existing revision rule; deferred roots and lost roots close traversal atomically and only a fresh controlled rescan relists; restricted operations (`list-folder:`, `changes:`, `start-token:`) survive generation transitions and fresh stores. |
| AC-04 Notifications/polling/bounded recovery | Covered, pass | Retry-After classification (valid, malformed, unrepresentable) is a single owner shared by polling and watch calls; account holds and resource minima are monotonic, generation-independent, published with checkpoints, adopted before the first provider call; rearm drops only local backoff. Watch quota answers hold the account; non-quota named minima restrict the specific create/stop operation. |
| AC-05 Identity and lifecycle | Covered, pass (one Low question) | Explicit `trashed=true` is treated as positive provider evidence and reconciled through the claim-aware owner without a probe; ambiguous `removed` stays on the absence gates; a lost bound root's partial-build support is withdrawn before publication; restored file roots clear their detail only after accepted ingestion. See L1. |
| AC-06 Access/revocation | Covered, pass | Trash removal retires only the reporting connection's claim and suppresses on the last (real-Postgres test); a reporting connection with no claim is a no-op and cannot reach another team. No visibility-widening path was introduced. |
| AC-07 Admin/operations | Covered, pass (one Low diagnostics gap) | Held runs report partial with the hold category; unpublished restriction owners reported once per run; local deadline categories preserved. See L4. |
| AC-08 Shared identity | Covered, pass (one Low question) | Google `author-email:` equivalence decided by one pure module shared by writer and readers; tombstones respected on automatic publication; ambiguous histories fail closed; unlink is exact-spelling; revision fence is key-bound. See L3. |
| AC-09 Roles and repair | Covered, pass (one Low diagnostics note) | Email-key obligations nominate by the same JavaScript comparison contract over a bounded superset scan; cursor advances over the whole page. See L2. |
| AC-10 Timeline | Partially touched, pass | `gdrive-contributions.ts` and `reattribute.ts` honour the held email bridge; an ambiguity blocks new credit but is not an unlink. |
| Migration/schema | Covered, pass | `20261031140000` is `create or replace` only, mirrored in `schema.sql`, replay-tested; keeps exactly the three restriction sections and still advances generation/revision/fence and refuses the stale worker. No numbering conflict in the tree. Cross-branch reservations not verifiable here. |

## Findings

All are Low. None is a confirmed functional defect.

**L1 — Question: unrelated trash now generates work.** `ingestion/aios_ingest/gdrive_sync.py:2690-2710`. Trigger: any Google Doc visible in the account's change feed is trashed while unselected and with no known parent. Before this patch the change was ignored. Now a `remove` obligation is enqueued and a brain reconcile call is made, which the claim-aware owner treats as a no-op. Consequence: unrelated trash activity in a broadly scoped account consumes per-run drain budget and brain reconcile capacity, and can trip the per-stream 5,000-item bound so an in-scope page is deferred with `queue_saturated` (the new test at `test_explicit_trash_evidence.py` confirms this behaviour). Scope is not widened and work stays bounded, so this is a cost/latency choice rather than a defect. Smallest narrowing if wanted: only enqueue membershipless trash when the stream has no published snapshot for the current generation, since that is the fresh-local-state recovery case the comment cites. Regression: N stray trashes under a stream with a published snapshot produce zero reconcile calls.

**L2 — Diagnostics: repair ledger undercounts scanned items for email keys.** `lib/ingest/identity-repair.ts:307-321`. Trigger: a Google email obligation whose page of 500 Drive items contains no matching evidence. The cursor advances by the whole page but `items_scanned` and the returned `scanned` are incremented by `candidates.length`, which can be 0. Consequence: the ledger's progress counter misreports a batch that did advance. Fix: pass `scannedPage.length` to the `items_scanned` update and to `scanned`. Regression: one batch with zero candidates records `items_scanned` equal to the page size.

**L3 — Question: ambiguous Google email history has no Admin listing.** `lib/identity/list.ts` (unchanged) joins the exact mapping state per row, so an address with several equivalent histories and no canonical decision is visible only in the OAuth callback page text (`app/api/auth/gdrive/callback/route.ts:49-51`). The refusals panel is explicitly historical. An Admin who did not perform the reconnect has no surface showing which address is held. The repair path (a fenced canonical relink) works. AC-08 asks for conflicting states to be exposed "as appropriate", so this is a judgment call. Smallest addition: mark rows whose canonical key resolves to `ambiguous` in the identities list.

**L4 — Diagnostics: a restricted folder listing is silent in the baseline.** `ingestion/aios_ingest/gdrive_sync.py` baseline loop (diff lines 2626-2641). Trigger: a standing `list-folder:` minimum excludes that folder's traversal rows. The build correctly stays incomplete, but the enumeration emits no `provider_restricted_resource` count for the held listing, so the run reports an incomplete baseline without naming the standing minimum. The added test asserts only `authoritative_complete is False`. Fix: count `provider_restricted_resource` once when `restricted_listings` is non-empty and a matching row remains open.

## Test gaps (not defects)

- No test asserts the count of brain reconcile calls produced by stray trash (L1).
- No test asserts `items_scanned` for an email-key batch with zero candidates (L2).
- No test asserts a diagnostic for a restricted folder listing (L4).
- Performance of `lockEquivalentGoogleEmailRows` (`lib/identity/member-identities.ts`), which takes `for update` on every `gdrive` identity row and mapping state of the team per Google email link or OAuth publication, is unexercised. Correctness is preserved because every caller already holds the team identity authority.

## Limitations

- No commands, tests, type checks or hash verifications were run. Hash and pass/fail claims come from the bundle.
- Migration-number reservations on other active branches were not inspected.
- The live sandbox certification gate is unaffected by this review and remains open.
