# Blind final review — Astra HIGH

**Verdict: HOLD — one High and two Medium findings.**

1. **High — Provider read restrictions also block verified removals.**
   - **Trigger:** An already imported document receives a long `503 Retry-After`, then a subsequent Drive change page reports it trashed or removed while its selected root remains readable.
   - **Expected:** Process the verified removal through claim-aware suppression without retrying the restricted provider read.
   - **Actual:** The change classifier creates a removal obligation, but the new `list_pending()` filter excludes every restricted ID regardless of action. The removal never reaches reconciliation, and pending work also prevents complete-snapshot reconciliation. Previously imported content therefore remains available until the deadline, potentially indefinitely for an unrepresentable restriction.
   - **Evidence:** `ingestion/aios_ingest/state.py:1513`, `ingestion/aios_ingest/gdrive_sync.py:2620,3311`.
   - **Acceptance impact:** AC-05/06 verified removal and suppression.
   - **Regression:** Import a document under a healthy folder in one stream; establish a document restriction; deliver an explicit trash/removal before expiry. Assert prompt claim retirement and inaccessible content, zero restricted provider reads, and preservation of another connection’s valid claim.

2. **Medium — Cross-stream removal probes discard provider deferrals.**
   - **Trigger:** Resolving a removal against another stream requires `_document_loss_verified()`, and its metadata request returns a quota deferral or a non-quota response naming `Retry-After`.
   - **Expected:** A quota answer stops account calls and persists the hold; a resource minimum persists and prevents another early probe.
   - **Actual:** `_document_loss_verified()` catches every `ProviderDeferred` and returns `False`. Neither restriction owner receives the evidence. The drain can continue with other documents/streams, and later runs can probe the same document before its named deadline.
   - **Evidence:** `ingestion/aios_ingest/gdrive_sync.py:3447`, called from `:3518` and removal drain at `:3329`.
   - **Acceptance impact:** AC-04 bounded recovery and honoring `Retry-After`.
   - **Regression:** Exercise a removal with a peer claimant or unreadable peer; inject `429`, quota `403`, and `503 Retry-After` specifically into this probe. Verify durable restriction, diagnostics, and no premature calls across restart.

3. **Medium — Watch renewal bypasses the new account hold.**
   - **Trigger:** A polling run publishes a future `account_hold`, then a renewal sweep acquires the connection while a watch is due.
   - **Expected:** Renewal honors the same account deadline before sending Google requests.
   - **Actual:** Renewal acquires progress and resolves account identity, then proceeds directly to watch creation and cleanup without consulting remote or local hold evidence. The provider authority check validates connection state and fencing only, so it does not close this gap. Carrying the hold unchanged in renewal checkpoints preserves the data but does not enforce it.
   - **Evidence:** `ingestion/aios_ingest/watch_renewal.py:423,455`, `lib/integrations/gdrive-authority.ts:932`.
   - **Acceptance impact:** AC-04 notification recovery and honoring `Retry-After`.
   - **Regression:** Publish a quota hold, make a watch due, and run renewal on both existing and fresh local state. Assert no watch/stop provider calls before expiry, preservation of existing watch evidence, and renewal afterward.

**Scope:** Complete 22-path tracked diff, all 20 added files, accepted specification, and relevant removal, reconciliation, identity, authority and renewal contracts. Packet base/recorded HEAD `5ecd2989e21fded915b41b508477bb267aaec06d`; tracked-diff SHA-256 `3fba7ef58921884657d101cb3694683a2a25482d5a1cb0db10c1bd0554f3de40`; archive SHA-256 `fd271527592d6a38000bcc69a450a6571958bd03df04ffdcbb11d68155998c23`.

**Limitations:** Static inspection only; no tests, execution, network, edits, or earlier review material consulted. Snapshot identity relies on the supplied manifest. Live sandbox and soak certification were not assessed.
