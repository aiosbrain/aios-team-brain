# AIO-1167 / PR743 — independent review of `b86b22d2`

**Verdict: ready for the next independent final reviews, with one Medium correction recommended first.** No High finding. The PR743 identity contract is implemented as adjudicated and the PR714/PR743 ownership boundary is respected. The one confirmed Medium is a reachable automatic-publication path that fails with an untyped error and a generic page. Everything else is Low or informational. This is not a merge, staging, production, or release readiness claim.

## Confirmed findings

**1. Medium — a same-member legacy `author-email:` spelling makes OAuth connect fail with a generic 500.**

- Trigger: a member has a live pre-canonicalization row such as `author-email:Alice@Example.com` (any spelling other than the canonical one), with or without a seeded `linked` mapping state, and no equivalent tombstone. That member's Admin connects Google Drive via OAuth with the verified email `alice@example.com`.
- Expected: automatic publication stores the credential and either links the canonical key or leaves the attribution visibly unresolved, like the `tombstoned` and `ambiguous` outcomes. If it must refuse, the refusal is typed and actionable.
- Actual: in `lib/identity/member-identities.ts:249-250` the other-owner check passes because the live row belongs to the same member. `canonicalState` is undefined and `otherStates` is zero or one `linked` state, so the decision falls through to the ordinary path. `lib/identity/member-identities.ts:278-284` then throws a plain `Error` ("a differently spelled Google identity … unlink it first"). `lib/integrations/gdrive-oauth.ts:224-227` does not catch it, the whole publication transaction rolls back (credential not stored), and `app/api/auth/gdrive/callback/route.ts:169` renders the generic 500 "The verified credential could not be stored" with no reconnect guidance. The resolver treats Google keys byte-exactly (`lib/identity/resolve.ts:30-38`), so the legacy row also does not resolve connector evidence.
- Impact: the account cannot be connected at all until an Admin discovers and unlinks their own legacy row. Fail-closed and safe, but an availability and operability defect on upgraded instances, and it bypasses the publisher's documented outcome set (publish, `tombstoned`, `ambiguous`, or `GoogleIdentityConflictError`). The ownership decision asked for existing behavior with zero equivalent tombstones; for automatic publication the pre-R47 behavior was to publish.
- Regression: real-Postgres test in `gdrive-identity-tombstone-email.datamechanics.test.ts` with `rawLink(alice, k.mixedAddress)` and no tombstone, then `publish(...)`. Assert the credential is stored, no canonical row or state is written, legacy row untouched, and the result is a typed outcome, not a thrown `Error`. Minimal fix: under `respectTombstone`, treat an equivalent live row of the same member as a standing decision (return a non-writing outcome such as `tombstoned`-style with `mappingKey` of the legacy spelling), or convert the throw to a dedicated error the callback maps to actionable text. Keep the explicit Admin path's refusal unchanged.

**2. Low — the callback cannot tell the Admin that the email identity was left unresolved.**

- Trigger: publication returns `tombstoned` or `ambiguous` for the `author-email:` key.
- Expected: the connected page says attribution for this account is unresolved and points to Admin → Members, as the spec requires the account to stay "visibly unresolved".
- Actual: `publishGoogleDriveOAuthCredential` returns only `{ status }` (`lib/integrations/gdrive-oauth.ts:232`), so `app/api/auth/gdrive/callback/route.ts:178` reports a plain "Connected …" success. Only the unverified-email branch at line 176 mentions mapping.
- Impact: a deliberate unlink or an ambiguous history silently looks like a linked connection on the completion page. Visibility exists elsewhere (Members identities), so Low.
- Regression: extend the publisher result with the email outcome and assert the callback text for the tombstoned and ambiguous cases.

**3. Low — a persistent non-terminal 4xx checkpoint refusal is never charged or exhausted.**

- Trigger: after an accepted push, the brain answers the checkpoint with a non-409 4xx (a contract or validation error) on every run.
- Expected: either backoff/exhaustion or a distinct diagnostic so the loop is bounded and visible.
- Actual: `ingestion/aios_ingest/gdrive_sync.py:3327-3338` reports the code and returns `False` without `fail_work`, so the obligation stays owed with no `not_before`, no failure count, and the content is re-pushed and re-refused every run. The partial status and the code in `failure_categories` are the only signals.
- Impact: unbounded repeated pushes for a brain-side bug; no data risk. Previously `_record_sink_failure` bounded this.
- Regression: a harness answering a 400 on checkpoint across several runs; assert the obligation gains backoff or a distinct category rather than a fresh push each run.

## Conditional and informational notes

- **Lock scope widened but ordered correctly.** `lockEquivalentGoogleEmailRows` (`lib/identity/member-identities.ts:107-134`) takes `FOR UPDATE` on every Google identity and mapping-state row of the team. Correctness holds because every writer and the per-key repair take the team identity authority first (`lib/identity/authority.ts:63-73`, `lib/ingest/identity-repair.ts:201-209`). Cost scales with the team's Google identity count on each email link or OAuth publication. No deadlock path found.
- **SQL versus JavaScript domain.** SQL selects only by team and `provider='gdrive'`; `canonicalIdentityId` is the sole arbiter in JavaScript. Writers have always lowercased `provider`, so no divergence remains. The non-ASCII and Unicode-whitespace test covers the arbiter.
- **PR714 boundary.** The generic writer gains optional parameters only; Slack callers (`app/api/auth/slack/callback/route.ts:119`, `lib/identity/provider-sync.ts:59`) are unaffected. PR714's advisory lock differs from the `identity-authority` lock; that reconciliation is MR-06's, as the decision states.
- **Uncertainty latch and reconciliation.** A drain-phase hold whose checkpoint loses its acknowledgment sets the client latch but not `acknowledgment_uncertain` (`gdrive_sync.py:1740-1767`). Further checkpoints are refused by the client, and the pending work keeps the roster incomplete, so I could not construct a case where a complete snapshot is submitted under an unknown revision. Conditional only.
- **Probe before the stream summary exists.** `_deferred_root_admissible` runs at `gdrive_sync.py:2178-2181` before the stream's `summary` and `try`, so an account hold raised by the probe escapes with `partial` unset and `probe_report` diagnostics dropped. Handled correctly by the coordinator; only the probe's own counts are lost.
- **Brain client parse leniency.** `brain_client.py:904` accepts exponent spellings such as `1e3` that the provider parser rejects. Internal server only, harmless.
- **SQLite JSON1.** `state.py:1523` depends on `json_each`; prior review noted this, unchanged.
- **Doc nit.** `docs/ARCHITECTURE.md:1441` names `linkMemberIdentity` as the reporter of `conflict`; it is `setMemberIdentity` under `respectTombstone`.
- **Migration.** `20261031140000_gdrive_restriction_generation_lifetime.sql` is create-or-replace only and mirrors the `schema.sql` trigger body exactly; the trigger binding is unchanged. Migrations are applied by directory listing, so no manifest entry is required.

## Acceptance and adjudication check

The three Astra corrections are present with real-Postgres coverage: `ambiguous` for more than one equivalent legacy state regardless of value (`member-identities.ts:264-268`), removal of the SQL lower/whitespace prefilter, and byte-exact `expectedRevisionKey` (`member-identities.ts:237-239`). The writer-correction items are all implemented, including the unlink-first overlap test and the email-only side-effect comparison. Conflict precedes tombstone refusal, legacy revisions are never rewritten, and explicit fenced relink resolves history. Unlink remains exact-spelling. The Python delta's acceptance rows (R48 D1/D2, R49 F1–F3, R50 F1–F7, R51 F1–F7, L1/L2, Note A, blind-final 1–4) each have the cited regression files present and matching the described behavior.

## Coverage and limits

I read the full 12,256-line source patch covering all 53 paths, the head state of the identity writer, OAuth publisher, identity authority, Admin link/unlink actions, OAuth callback, grant policy, authority error paths, Picker/save catch blocks, scheduler classification, renewal connection body, checkpoint tail, coordinator tail, identity repair worker, transaction nesting, and the schema trigger. I did not run tests or commands, did not verify packet hashes, and did not read the remainder of `gdrive_sync.py`, `state.py`, or the `_DriveWorld` double beyond the patched hunks and the regions cited above.
