**Verdict: PASS.** The four corrections close adjudication findings 1–4 as accepted, and I found no regression in the changed contracts or their callers. No confirmed High or Medium finding. Three low/speculative notes follow, none blocking.

## Delta identity

The manifests agree with the packet: seven paths differ, three changed and four added, with the other 39 byte-identical. The worktree copies of the changed hunks and the three new tests match the packet's affected diff line for line. I could not hash files or extract the tarballs without running commands, so the worktree reads stand in for the archives.

## Correction-by-correction assessment

**1. Verified removal under a resource restriction (High) — closed.**
- Admission is now action-aware at `ingestion/aios_ingest/state.py:1515`. A `remove` passes the restriction filter; upserts and restorations stay excluded.
- Both probe sites in the cross-stream owner are gated before any read: the claimant path at `ingestion/aios_ingest/gdrive_sync.py:3570` and the unreadable-peer or unknown-roster path at `:3598`. The two no-read settlements are untouched: single-stream known roster at `:3561` and all-barriers-passed at `:3586`.
- A `restricted` verdict is retained with `failure=False`, keeps the stream partial via the held-back diagnostic, and never acknowledges or honours a claim. The restriction row is not modified by the removal path.
- Overlap preservation is sidecar-side only: the sidecar sends one `removed_provider_ids` reconciliation under its own integration id. The claim-aware brain owner is unchanged and not re-reviewed here.

**2. Deferred removal probes (Medium) — closed.**
- The probe re-raises at `gdrive_sync.py:3493`. The removal branch routes it at `:3347-3358`: local deadline breaks the drain untouched, quota becomes the account hold, and a named non-quota wait goes through the shared document-deferral owner at `:3446-3470`. Malformed headers stay local backoff with the diagnostic. The removal is never acknowledged on any of these paths.

**3. Watch renewal account hold (Medium) — closed.**
- Adoption and the hold check sit after account verification and before the provider gate at `ingestion/aios_ingest/watch_renewal.py:452-471`. Recovery still publishes record outcomes, which is brain-only.
- Same-account semantics hold: `connection_hold` spans generations by credential, and `parse_restriction_evidence` ignores the section's generation at `ingestion/aios_ingest/connector_state.py:268-294`. Adoption reads only the verified credential's entry. Renewal and the coordinator derive the same namespace through `oauth_account_namespace` and `service_account_namespace`.
- Recovery publication under a hold cannot erase it: `renewal_document` deep-copies the acknowledged document and replaces only `watches` at `connector_state.py:105-113`.

**4. Standing identity prerequisite publication (Medium) — closed.**
- The early return now builds the held summary and flushes once before returning, with no identity read, at `affected-files-current-vs-base.diff:946-957`. The flush reuses the authority-refusal, uncertainty-latch and unpublished-diagnostic semantics unchanged.

## Test discrimination

The three modules distinguish the required outcomes rather than only passing:
- Restricted removal covers finite and unrepresentable minimums crossed with last-claim and overlap, asserts zero metadata or content reads, restriction untouched, restoration still withheld until lapse, and the ambiguous cross-stream move retained with no probe (`ingestion/tests/test_restricted_removal.py:68-166`).
- Deferral routing covers 429 and quota 403 on both probe paths with same-path restart and zero calls, 503 with restriction and resource-only isolation plus restart and post-expiry reconciliation, local deadline leaving zero failures, and malformed header with bounded fallback (`:216-312`).
- Watch hold covers due creation and due cleanup with retained-local and acknowledged-only state, expiry, cross-credential non-adoption, and earlier-generation holds (`ingestion/tests/test_watch_account_hold.py:55-152`).
- Prerequisite covers retry before expiry, fresh-state honouring, repeated failure, two terminal authority codes, and the uncertainty latch, each asserting exactly one identity read (`ingestion/tests/test_identity_prerequisite_publication.py:135-214`).

## Speculative notes (non-blocking)

- **Low, environment: first JSON1 dependency.** `list_pending` now uses `json_each` at `state.py:1515`, the only such use in the sidecar. Trigger: a deployment SQLite built without JSON1. Expected: drains run. Actual: every `list_pending` call errors. Python wheels and SQLite 3.38+ include it, and the suite passed, so this is a portability note. Recommend a parameter-expanded `NOT IN` or a startup capability check, with a test.
- **Low, policy: named deferrals charge the removal's retry budget.** `_defer_document_read` records a failure for a 503 probe at `gdrive_sync.py:3464-3468`, so repeated named deferrals across lapses can exhaust a verified removal until Admin rearm. This matches content reads and never acknowledges, but content stays visible longer. Recommend a test asserting the exhausted removal is still reported as backlog, or a decision to use `failure=False` for provider-named waits.
- **Low, coverage gaps.** No test for multi-stream all-barriers-passed plus restricted settling without a read, no fresh-state-file restart for the Fix 2 restriction, and no direct assertion that renewal's recovery publication preserves restriction sections. All three behaviours were verified by reading the code.

The writer-result phrase that `watch_renewal.py` was "unchanged from HEAD before this round" reads as "first modified in this round," which the manifests confirm. It is a reporting ambiguity, not a code finding.

## Scope limitations

- No commands or tests were run. The coordinator's 997-pass result is taken as reported, not as proof.
- Tarballs were not extracted. Worktree files were read instead and match the packet diff for every delta hunk.
- The brain-side claim-aware removal and cache owners were not re-reviewed. Overlap survival is proven only against the test ledger double.
- The held identity/tombstone finding for PR #714 was not examined, as instructed.