Status: inspection complete. I traced the authorization and API boundaries, OAuth/broker/token handling, identity discovery and tombstones, claims/reconciliation/revocation, lease/fence/recovery, quota/retry, sanitization, the Admin conflict diagnostic, and the Python coordinator/state store. Writing up now.

## Verdict: changes required

No HIGH-severity defect found in the areas traced. One confirmed MEDIUM defect in automatic identity linking (F1), one confirmed control-plane failure-budget leak (F3), and two acceptance gaps (F2, F4) that should be adjudicated before the next gate. Reviewed snapshot: base `8df51664`, HEAD `02107ca6`, working tree clean. Read-only review; no tests were run, so every "passed" claim in the handoff records remains unverified by me.

## Confirmed defects

**F1. MEDIUM. OAuth publication re-creates identities over deliberate unlink tombstones.**
- Where: `lib/integrations/gdrive-oauth.ts:210-222` calls `setMemberIdentity` for `subject:<sub>` and `author-email:<email>`. `lib/identity/member-identities.ts:111-128` reads the mapping-state row only for its revision and inserts when no `member_identities` row exists, then `advanceIdentityMappingState` flips `unlinked` to `linked` (`:154-157`). Only `discoverMemberIdentity` honors the tombstone (`:233-240`).
- Trigger: Admin unlinks `author-email:alice@x` (or the subject) from member A in Admin → Members, producing `state='unlinked'`. Any Admin later connects or reconnects the Drive account whose Google-verified email is alice@x.
- Expected (AC-08 "preserve intentional manual mappings"; the module's own contract that a tombstone "always wins"; `lib/ingest/gdrive-contribution-store.ts:126-128` refuses email fallback for a tombstoned id): credential stored, account left unresolved, tombstone untouched.
- Actual: both links are silently re-created, a repair obligation and epoch advance are queued (`member-identities.ts:57-68`), and credit for every `author-email:alice@x` contribution returns to A.
- Evidence: no tombstone check exists in `gdrive-oauth.ts`; `test/datamechanics/gdrive-oauth-*` contain no unlink scenario (grep for `unlinked|tombstone|removeMemberIdentity` under `test/**oauth**` matches only an unrelated subject-only case).
- Regression test (real Postgres): `setMemberIdentity` then `removeMemberIdentity` for `author-email:a@x` and `subject:S`; call `publishGoogleDriveOAuthCredential` with `subject:S`, `email:a@x`, `emailVerified:true`; assert the credential is stored, no `member_identities` rows exist, both states remain `unlinked` at the same revision, no `identity_repair_obligations` row, and `team_authorization_epochs` unchanged. Same shape for `syncProviderIdentities` if the tombstone promise is meant to hold for Slack/Linear/Plane too.

**F3. MEDIUM. A lost checkpoint acknowledgment charges document failure budget for the rest of the run.**
- Where: `ingestion/aios_ingest/brain_client.py:544-590` advances the local progress revision only on a 200. A checkpoint the brain committed whose response was lost (timeout, or 5xx after retries) leaves the client one revision behind. The next checkpoint with different progress is refused `stale_progress` by `lib/integrations/gdrive-authority.ts:839-851` (idempotent only when the JSON is identical). `stale_progress` is not in `_TERMINAL_AUTHORITY_CODES` (`gdrive_sync.py:42-45`), so `_push_doc` (`:2359-2362`) routes it to `_record_sink_failure`, which calls `_fail_work` (`:2630-2648`) and spends the document's retry budget. Every later document in that run repeats the failure, since the revision never resyncs until the next acquire.
- Expected: same principle Astra required for M5. A control-plane acknowledgment problem must not count as a document failure or exhaust an accepted document; the client should resync the revision (re-read the returned `progress_revision`, or re-acquire) instead of failing every remaining checkpoint.
- Actual: one lost checkpoint ack means `failures+1` on each subsequently pushed document that run, with `stale_progress` as the recorded error.
- Regression test: stub the checkpoint endpoint to commit server-side but return a 504 once, then answer normally; run two documents; assert `work_failures == 0` and `exhausted_at IS NULL` for both, and that the second document's checkpoint is acknowledged in the same run. Extend `ingestion/tests/test_drain_recovery.py`.

## Acceptance gaps and uncertain risks

**F2. MEDIUM, acceptance gap (AC-08 "report conflicts"). The new Admin conflict diagnostic cannot fire on any upgraded database.**
- Migration `postgres/migrations/20260922180000_gdrive_identity_repair_ledger.sql:74-77` seeds a `linked` state for every existing `member_identities` row; every application writer also writes state (`member-identities.ts:154-171`, `:256`). So an "unreviewed legacy mapping", the only shape that produces `identity.discovery_conflict` (`:241-249`), exists only when inserted by raw SQL, which is exactly how the real-Postgres test manufactures it (`test/datamechanics/identity-discovery-conflicts.datamechanics.test.ts:41-45`).
- A genuine disagreement (permission id previously auto-linked to B, later observed with A's confirmed email) returns `reviewed` with no audit and no UI row (`gdrive-identity-discovery.ts:61-64`, `member-identities.ts:240`). Admin → Members will always read "No Google Drive automatic links have been refused".
- This is adjudicated semantics (a reviewed mapping is not remapped), but the shipped diagnostic does not surface the conflicting state the spec names. Recommend recording a distinct, non-mutating `identity.discovery_disagreement` event for reviewed links with a differing confirmed email and projecting it in the same panel, or documenting that the panel is legacy-only. Test: link `permission:P` to B through `discoverMemberIdentity`, replay a push for `permission:P` with A's confirmed email, assert an Admin-visible row and no mapping change.

**F4. MEDIUM, uncertain risk (AC-05/AC-07). One permanently failing document blocks scope-wide absence reconciliation forever.**
- `gdrive_sync.py:1153-1163` submits the complete snapshot only when every stream's `pending_count == 0`; `state.py:1496-1501` counts exhausted obligations as pending. A document that always fails extraction (over `max_chars`, or malformed) exhausts after 8 attempts and then stays owed indefinitely; "Retry pending work" only re-arms it to fail again.
- Consequence: `authoritative_complete` is never reached, Admin shows "No proven complete success" permanently, and selected-scope absence (needed after folder moves, scope changes and rescans) is never established for the whole connection. Individual change-stream removals still work.
- Whether this is a defect or an accepted conservative design needs adjudication; the membership snapshot is complete even when one body failed, so the gate could admit exhausted upsert obligations whose metadata was verified in selection. Test: three documents, one always `limit_exceeded`; after nine runs assert whether the run can ever report `authoritativeComplete`.

**F5. LOW. Account-wide Retry-After is still not persisted before stream admission.** `gdrive_sync.py:938-945` and `:1003-1010` return a failed summary on `ProviderDeferred` during root binding and start-token capture without writing `retry_not_before`, so the next poll retries Google immediately. The handoff records this as out of scope for H1; it remains an AC-04 gap.

**F6. LOW. Admin test/preview bypasses the broker's grant-ceiling policy.** `app/t/[team]/admin/integrations/actions.ts:79-91` and `:1193-1209` refresh the token directly and never call `evaluateGdriveGrant`, so a credential whose refresh now returns a broader grant previews as healthy while the connector's broker refuses it (`gdrive-authority.ts:1019-1027`). The addendum asks tests and previews to use the same provider policy.

**F7. LOW. Empty-selection stream namespace ignores the brokered account.** `gdrive_sync.py:791-797` computes `credential_identity(options)` before the OAuth branch sets it (`:849`), so the synthetic empty stream and its cursor-age roster are namespaced by the local fallback hash, not the verified account.

**F8. LOW. Manual Google identity ids are case-sensitive while connector ids are lowercased.** `providerKey` preserves bytes for `gdrive` (`lib/identity/resolve.ts:30-38`); the sidecar and OAuth publisher lowercase `author-email:` values, but `linkMemberIdentity` only trims (`app/t/[team]/admin/members/actions.ts:200`). An Admin typing mixed case creates a mapping that never matches.

## Previously deferred items still present

M2 (unbounded identity-authority wait on every provider-gate call: `authorizeGdriveProviderCall` has no `withBoundedLockWaits`, and the sidecar gate client times out at 15 s into `authority_unavailable`), M4 (`audit()` aborts an ambient pool transaction on insert failure, `lib/api/audit.ts:41-45`), L5 (unused SQLite leases, `state.py:2287-2330`), L6 ("Paused or disconnected" copy) and H2 (seeded pending repair fences all attributed reads until drained) are unchanged. H1/M5/M6/L2/M8/L8 corrections are present in code as described in the handoffs.

## Verified sound

OAuth state is single-use, expiring and browser-bound; the callback re-checks the initiating Admin before exchange. The broker issues only access tokens, re-validates the fence after the network call, and refuses issuance without a committed audit row. Execution authority binds integration, team, key, member, generation, fence and lease atomically on every content, reconcile and discovery write; stale owners get `stale_execution`. Ordinary and external keys see Drive config reduced to `authMode`. Complete snapshots require root coverage on both sides. Claims, retirement, suppression, cleanup obligations and the epoch barrier are coherent, and the Timeline cache checks the epoch under lock on memory, persisted and publish paths. Ownership is kept out of authorship; corrections lock evidence on both read and repair paths. Notifications are hints validated against resource id, token hash and expiry.

## Verification limitations

I ran nothing. I did not read the bodies of most test files, the arc/graph provenance changes, `schema.sql` parity, the HTTP-tier harness, or the two-process sidecar driver. Live certification (25 documents, 24-hour soak, two tenants), the H2 repair drain on target environments, and opt-in rollout remain open release gates per the spec and are not addressed by this review.
