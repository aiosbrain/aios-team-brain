I've finished reading the delta and its callers. Writing up the report now.

## Review report — source delta b86…→4f515e0 (review HEAD 05944f3)

**Scope covered.** Full `source-delta-b86.diff`, manifest, accepted spec, PR714 decision. All 18 changed files read in full on the TS side; on the Python side the changed functions plus their callers: `_enumerate_baseline` root loop and traversal loop, `_deferred_root_admissible`, `settle_root`, `mark_root_deferred`, `record_root_unavailable`, `hold_connection`, `publish_selection_snapshot`, `materialize_page`, `_Run.offload`, `_create`, `_cleanup`, `_create_where_due`, `_renew_connection`. Grepped every consumer of `providerIdentityState`, `canonicalIdentityId`, `googleEmailKey`, `googleEmailAttributionHeld` and of evidence `mapping_revision` under `lib/` and `app/`.

### Confirmed actionable issues

**F1 — High. A lost folder restored while its traversal is still open is settled as bound, and the build publishes without the withdrawn content.**
- Trigger: run N answers a bound folder root 404 while the build is open. `record_unavailable` succeeds and `withdraw_lost_root_support` strips every member the root supported (`gdrive_sync.py:2906-2912`). The traversal loop closes the root's queued entries empty one per iteration (`gdrive_sync.py:3053-3064`), but sibling listings consume the page budget, or `_finish_materialized_pages` leaves a page uncommitted and returns early (`:3131-3133`), so some of the root's entries remain open. Run N+1 reads the root present again (access regranted, undeleted).
- Expected: the root must be listed again in full before any complete snapshot (the delta's own restore rule).
- Actual: the restore branch applies only when `not state.root_traversal_open(...)` (`gdrive_sync.py:2913-2918`). With entries still open it falls through to `state.settle_root(...)` (`:2931`), whose SQL clears the unavailable detail for a bound row (`state.py:1121-1129`). The remaining entries are listed, the already-closed-empty pages are never revisited (`next_traversal` skips completed entries, replay never reapplies membership), the build completes (`:3140-3143`) and publishes a complete snapshot missing the pre-loss-listed documents. Fenced reconciliation then deletes documents that exist at the provider. Pre-delta the never-listed subtree gap existed, but the delta additionally withdraws the pre-loss membership, so this snapshot now also drops documents this build had listed.
- Fix: in the restore branch, defer whenever the binding carries `_ROOT_UNAVAILABLE_DETAIL`, regardless of traversal state. The deferred path already closes open entries with the retained placeholder (`:3038-3052`) and routes to the controlled rescan.
- Regression: extend `test_a_folder_restored_after_its_loss_in_the_same_build_is_listed_again_before_completion` with `finished=False` and a page budget that leaves A entries open after the loss run; restore; run to complete; assert every A document is in the reconciled snapshot and none is in `ledger.deleted`.

**F2 — Low. Callback omits a held subject when the email outcome is `linked` or `preserved`.**
- `app/api/auth/gdrive/callback/route.ts:188-205` returns `""` for `{subject:"tombstoned", email:"linked"}` and only the preserved sentence for `{subject:"tombstoned", email:"preserved"}`, so the Admin is not told the Google identity stays deliberately unlinked. `test/gdrive-callback-identity-outcome.test.ts` covers only subject tombstoned with email tombstoned.
- Fix: emit the subject sentence whenever `identity.subject !== "linked"`; add both cases to the test.

### Verified as correct
Shared history rule and exact-key fence are identical in writer (`member-identities.ts:262-292`) and readers (`resolve.ts:174-201`); the `preserved` branch writes nothing and is idempotent; readers hold the email bridge consistently in author resolution, contribution store, Timeline projection and `explicitlyUnlinked`; the email-path repair scans a bounded superset and advances the cursor over the whole page (`identity-repair.ts:260-321`); `withdraw_lost_root_support` is building-only, transactional and idempotent; late quota answers journal only through the monotonic `hold_connection`, on the loop, and are re-checked before each create and stop; Slack and opaque-id semantics are untouched (`providerKey`, `canonicalIdentityId`).

### Hypotheses and deferred concerns
- Email-keyed obligations now scan every Drive document with evidence in the team per obligation. Bounded per batch, but O(all Drive docs). Performance only.
- `gdrive_contribution_evidence.mapping_revision` is null when the governing history lives under a legacy spelling. Nothing in `lib/` reads it as a fence, so informational.
- A live canonical row plus one legacy tombstone leaves an inert live row (reader deletes credit, writer reports tombstoned). Consistent fail-closed, but inconsistent-legacy data stays visible in identity lists.
- `lockEquivalentGoogleEmailRows` locks all of the team's gdrive rows for update. Pre-existing, outside the delta.

### Limitations
No tests or shell were run. Not read: `_DriveWorld` harness, `_finish_materialized_pages`, the reconciliation path, `DRIVE_OBLIGATION_PROVENANCE`, `withIdentityMutationBoundary`, `provider-sync.ts`, the PR714 worktree itself.

## Verdict: CHANGES REQUIRED

F1 must be fixed and covered before this snapshot can pass. F2 is a messaging fix that can ride along.
