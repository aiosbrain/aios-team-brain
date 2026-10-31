# Blind final review — GPT-6.1 Sol HIGH

1. **High — Resource restrictions also block confirmed removals.**
   - **Trigger:** An already imported document under a healthy folder receives a non-quota 503 with a long `Retry-After`; a subsequent change page reports that document removed or trashed.
   - **Expected:** Suppress its claim/content through the existing removal owner without making an early provider read.
   - **Actual:** The page creates the removal obligation, but the restriction filter excludes every action for that ID, including `remove`. In a single-stream connection, removal needs no provider read, yet remains blocked until restriction expiry, potentially indefinitely for an unrepresentable wait. Existing content remains available because reconciliation never receives the removal.
   - **Evidence:** `state.py:1513`, `gdrive_sync.py:2620,3310,3326`.
   - **Acceptance impact:** AC-05/06 lifecycle and revocation suppression.
   - **Regression:** Import a folder document, restrict its reads, then process an explicit trash/removal event before expiry. Assert claim retirement and suppression occur without rereading or restoring the document; preserve overlap protections.

2. **Medium — Watch renewal bypasses the new account hold.**
   - **Trigger:** Polling publishes an account-wide quota hold while a watch is due for creation or cleanup.
   - **Expected:** Subsequent provider operations for that verified account honor the standing deadline.
   - **Actual:** Renewal acquires the same progress but proceeds from account resolution directly to provider-gate creation, watch dispatch and cleanup. It never checks local or acknowledged restriction evidence. The provider gate checks execution authority only, so it does not prevent these early calls.
   - **Evidence:** `gdrive_sync.py:1406`, `watch_renewal.py:432,447,455`, `gdrive-authority.ts:932`.
   - **Acceptance impact:** AC-04 Retry-After handling across polling/watch recovery.
   - **Regression:** Open a hold through the coordinator, then run renewal with due creation and cleanup records, using both retained and fresh local state. Assert zero provider operations before expiry and normal resumption afterward.

3. **Medium — Standing service-account prerequisite return never retries restriction publication.**
   - **Trigger:** The service-account identity request names a long `Retry-After` and the restriction checkpoint fails before acknowledgment.
   - **Expected:** A fresh acquisition should attempt to publish the locally retained restriction and continue reporting it unpublished if that attempt fails.
   - **Actual:** The initial failure records and attempts publication, but every following run returns immediately when the identity prerequisite remains restricted. That return calls neither `_flush_restriction_evidence` nor the unpublished diagnostic owner. The restriction stays local for its lifetime despite a recovered brain, and subsequent reports omit its missing remote durability.
   - **Evidence:** `gdrive_sync.py:1431,1470`.
   - **Acceptance impact:** AC-03/04 restart recovery and AC-07 truthful durability diagnostics.
   - **Regression:** Fail the first prerequisite-restriction publication, recover checkpoint service, and reacquire before expiry. Assert publication succeeds without a provider read; a fresh state file must then honor it.

4. **Medium — Canonical email linking overlooks legacy unlink tombstones.**
   - **Trigger:** A previously supported mixed-case identity such as `author-email:Alice@Example.com` is explicitly unlinked, then the verified Google account reconnects.
   - **Expected:** The deliberate unlink remains effective across namespace normalization.
   - **Actual:** Unlink preserves the stored spelling and writes its tombstone under that spelling. The new writer canonicalizes the reconnect ID before exact mapping-state lookup, missing the tombstone. The alternate-spelling check examines only live identity rows, which unlink deleted, so automatic publication recreates a canonical link and repair obligation.
   - **Evidence:** `member-identities.ts:108,139,164,333,360`.
   - **Acceptance impact:** AC-08 backward compatibility and deliberate mapping decisions; AC-09 repair can restore unwanted credit.
   - **Regression:** Seed a legacy mixed-case link, unlink its exact stored spelling, and reconnect with its verified lowercase email. Assert no automatic canonical link, mapping revision, or repair obligation appears; explicit fenced relinking should remain available.

**Verdict: HOLD — one High and three Medium findings.**

**Scope:** Accepted specification, all 22 modified paths in the frozen tracked patch, all 20 added files in the archive, and relevant candidate callers/contracts. Packet base and HEAD `5ecd2989e21fded915b41b508477bb267aaec06d`; tracked patch SHA-256 `3fba7ef58921884657d101cb3694683a2a25482d5a1cb0db10c1bd0554f3de40`.

**Limitations:** Static inspection only; no tests, programs, writes, network, MCP, earlier reports, adjudications, acceptance maps, or handoffs. Runtime behavior, migration execution, live Google certification, and operational readiness were not established.
