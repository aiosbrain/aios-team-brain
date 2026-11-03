# GPT-6 Astra blind final review — PR743 candidate `1a9ca615`

**Verdict: CHANGES REQUIRED.** Three concrete findings remain.

Reviewed candidate `1a9ca6151a4ad98fe704476382f0bfd1170ea253` against base `5ecd2989e21fded915b41b508477bb267aaec06d`. The supplied 65-path source patch matches SHA-256 `7e0407dfcebfa0faf0f076e94382b38141eef6fd1cab9b2064c97c5a865374ee`.

## 1. [P2] Listing and change-page Retry-After deadlines disappear across generation changes

A folder listing returning a non-quota `503 Retry-After: 86400` becomes a `ProviderDeferred`, but the baseline handler stores its deadline only in the stream’s `retry_not_before`. The change-page handler does the same. A scope edit or same-account credential replacement increments generation and clears stream progress; the retention function preserves only `account_hold`, `document_restrictions` and `retained_restrictions`. The new generation can therefore repeat the restricted listing before the provider’s deadline.

Expected: the provider minimum survives scope/credential transitions for the same verified account and resource or operation. Actual: only document/resource restrictions and account quota holds receive that protection.

Evidence:

- `ingestion/aios_ingest/gdrive_sync.py:3094`: baseline `files.list` dispatch.
- `gdrive_sync.py:2238–2248` and `2377–2388`: non-quota deferrals checkpoint stream-only deadlines.
- `postgres/migrations/20261031140000_gdrive_restriction_generation_lifetime.sql:29–33,73–76`: retained sections exclude stream deadlines.
- `ingestion/tests/test_restriction_lifetime.py:64–67` exercises document restrictions; its transition helper at lines 37–43 demonstrates the stream reset. It does not cover a listing/change-page minimum.

This violates AC-04’s requirement to honor valid Retry-After. Add generation-independent restriction evidence for these operations, with a regression covering a long non-quota listing minimum followed by a scope edit and same-account reconnect.

## 2. [P2] Watch creation and cleanup discard non-quota Retry-After deadlines

When Google responds to watch creation or channel stop with `503 Retry-After`, `_raise_if_quota` leaves the exception unchanged because it recognizes only quota failures. Creation records an uncertain outcome containing the exception type; cleanup increments its stop-attempt counter. Neither retains the supplied deadline. A subsequent renewal sweep can create another watch for the same stream or retry the same channel stop before that deadline.

Expected: preserve outcome uncertainty while deferring the affected operation until the valid provider minimum expires. Actual: only quota responses carry a durable wait.

Evidence:

- `ingestion/aios_ingest/sources/gdrive_watch.py:33–41,149–156,165–170`.
- `ingestion/aios_ingest/watch_renewal.py:453–455`: generic creation failure loses header/deadline information.
- `watch_renewal.py:508–517`: generic stop failure retains an attempt count but no wait.
- `watch_renewal.py:638–660`: another creation remains eligible below the unresolved-attempt limit.
- `ingestion/tests/test_watch_quota_hold.py:515–543` checks that ordinary 5xx failures do not create account quota holds, but does not test 5xx with Retry-After or a second sweep before expiry.

This also violates AC-04. Preserve an operation-specific minimum without treating every 5xx as an account-wide quota hold.

## 3. [P2] Recognized padded legacy Google identity keys cannot be manually corrected through the prescribed unlink path

The new equivalence handling recognizes legacy keys with outer Unicode whitespace and whitespace after `author-email:`. A live equivalent legacy row prevents creating/remapping the canonical key and instructs the administrator to unlink it first. However, the admin unlink action trims the stored key before observing it, and `removeMemberIdentity` also trims it and rejects whitespace following the colon. Consequently, an outer-padded row cannot be found by its exact stored key; an internally padded key is rejected. The required unlink-then-link recovery is unavailable.

Expected: an authorized, revision-fenced unlink can remove the exact persisted legacy key and create its tombstone without rewriting another key’s identity or revision. Actual: the recognized legacy mapping can block canonical correction while being impossible to unlink through this API.

Evidence:

- `lib/identity/member-identities.ts:295–300`: equivalent live mappings require explicit unlink first.
- `app/t/[team]/admin/members/actions.ts:339,349`: trimming changes the lookup key.
- `lib/identity/member-identities.ts:459–462,469–478`: trimming/validation precedes exact-key lookup.
- `test/datamechanics/gdrive-identity-tombstone-email.datamechanics.test.ts:498–521` includes these legacy spellings and a live outer-padded mapping.
- Its exact-spelling unlink test at lines 575–591 covers mixed case, but not the padded spellings recognized by the new equivalence contract.

This leaves the AC-08 manual correction path incomplete. Extend exact-key unlink coverage to these supported legacy spellings while retaining holder/revision fencing.

## Scope and limits

The review covered production changes and affected contracts for root binding and partial enumeration, page completion and reconciliation, provider/control-plane retry handling, watch lifecycle, generation retention, credential publication and audience authorization, shared identity resolution, contribution projection, and historical repair. Relevant tests were inspected without treating names or comments as proof.

This was a static, read-only review. No commands or tests were run, no edits were made, and no prior review, adjudication, writer report or handoff was consulted. Automated verification and the accepted live certification requirements remain outside this review’s evidence. No merge or deployment readiness is claimed.
