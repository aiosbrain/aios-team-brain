# AIO-1167 R51 blind-final correction — writer result (Opus 5.5 HIGH, sole writer)

Prompt: `r51-blind-final-correction-prompt-20261031.md`; adjudication `r51-blind-final-adjudication-20261031.md`. Scope: the four ingestion restriction/watch fixes only. **Identity slice (finding 5) not touched:** `lib/identity/member-identities.ts` and `lib/integrations/gdrive-oauth.ts` are byte-identical to the frozen blind-final manifest (`.context/aio1167-review-bundles/r51-blind-final-20261031T1858Z/manifest.json`). No commit, push, review dispatch or PR change.

## Changed paths
These are the only differences from the frozen manifest (42 entries):
- `ingestion/aios_ingest/state.py`:
  - `list_pending` is now action-aware: a restricted ID is excluded except for a `remove`.
  - `has_owed_work(exclude_action=)`.
- `ingestion/aios_ingest/gdrive_sync.py`:
  - Removal branch: probe deferrals are routed; a `restricted` verdict is added.
  - `_defer_document_read` is the single non-quota deferral owner, shared by the content-read and removal-probe paths.
  - `_document_loss_verified` re-raises `ProviderDeferred`.
  - `_cross_stream_removal(restricted=)` never probes a restricted document.
  - The standing identity-prerequisite return now flushes restriction evidence once.
  - The held-back diagnostic excludes removals that proceed.
- `ingestion/aios_ingest/watch_renewal.py` (unchanged from HEAD before this round): after account verification, it adopts this account's acknowledged evidence and enforces a standing account hold. Projection rebuild and `_recover` (no provider call) still run; under a hold, the provider gate, creation and cleanup do not.
- `docs/ARCHITECTURE.md`: restriction admission, probe deferral, prerequisite flush, and the watch hold.
- New tests:
  - `ingestion/tests/test_restricted_removal.py` (16)
  - `ingestion/tests/test_watch_account_hold.py` (7)
  - `ingestion/tests/test_identity_prerequisite_publication.py` (5)

## Behaviour
1. **High — verified removal under a resource restriction.** A trash or removal of a restricted document reaches `reconcile_gdrive(removed_provider_ids=…)` in the same run, with zero reads of the document, for both finite and unrepresentable minimums. The restriction row is unchanged. Our ledger claim is retired; another connection's claim survives, and with no other claim the content is suppressed. A later restoration upsert is still not read until the minimum lapses. An ambiguous cross-stream move of a restricted document stays pending: no probe, no removal, and the removal stays owed.
2. **Medium — deferred removal probes.** On both the claimant and the unreadable-peer paths:
   - a 429 or quota 403 becomes the account hold (nothing is read after it, and a restart makes zero calls);
   - a 503 with a long Retry-After becomes the document's restriction, with no account hold, and independent work in the same run continues;
   - before the minimum, the removal is neither probed again nor acknowledged, across a restart;
   - after it, the probe runs again and a deleted document is reconciled;
   - `dispatch_deadline` opens no hold or restriction and leaves the removal untouched;
   - a malformed header keeps its bounded fallback, records one failure, and reports `retry_after_malformed`.
3. **Medium — watch renewal account hold.** A due creation and a due cleanup make zero dispatch or stop calls (and never open the provider gate) while held. This holds with the hold retained locally or acknowledged only (fresh state file). Records, stop attempts and cursors are unchanged, and normal create or stop follows expiry. Another credential's hold is not adopted. A hold from an earlier generation of the same account still holds.
4. **Medium — standing identity prerequisite.** A fresh acquisition publishes the locally retained restriction once, with no identity read, and a fresh state file honours it. A repeated failure reports `document_restriction_unpublished`. A `stale_execution`/`connection_unavailable` refusal keeps the evidence, reports the code, and sends nothing more. Under the uncertainty latch nothing is sent and the evidence is reported unpublished.

## Verification (writer, 2026-11-01)
Commands run from `ingestion/`:
- `.venv/bin/python -m pytest tests/test_restricted_removal.py tests/test_watch_account_hold.py tests/test_identity_prerequisite_publication.py -q` → 16 + 7 + 5 = **28 passed**.
- `.venv/bin/python -m pytest tests -q` (full sidecar suite) → **996 passed, 28 skipped, 1 failed**. The failure, `test_codebase_analyzer.py::test_history_backfill_leaves_the_1_22_fields_unknown`, is unrelated and environmental:
  - `analyzers/codebase.analyze_history` passes a UTC calendar date to `git rev-list --before=`, which git reads in local time (IST).
  - Between 00:00 and 05:30 IST the just-made commit falls after that bound, so the test fails only in that window; it ran at about 00:45 IST.
  - It shares no module with this diff, and passed in the coordinator's earlier full run. It is a pre-existing clock-window test or product bug, out of scope.
- `npm run check:docs` → congruent. `git diff --check` → clean.

Mutation checks: each targeted mutant turned tests red, and the source was restored byte-identical.

| Fix | Mutant | Tests turned red |
|---|---|---|
| 1 | filter not action-aware | 5 |
| 1 | restricted flag ignored | 1 |
| 2 | probe swallows the deferral | 10 |
| 2 | deadline becomes a failure | 2 |
| 2 | quota becomes a document deferral | 4 |
| 3 | no hold gate | 6 |
| 3 | no adoption | 3 |
| 3 | hold keyed on the wrong credential | 7 |
| 4 | no prerequisite flush | 5 |

Not run: TypeScript checks and vitest/data-mechanics/HTTP tiers (no TS file changed this round).

## Notes and limitations
- `watch_renewal.py` imports the two existing owners `_adopt_remote_restriction_evidence` and `_standing_account_hold` from `gdrive_sync` (underscore-private). This reuses the one restriction owner rather than duplicating it.
- The held-back diagnostic (`provider_restricted_document`) can report a document in a run whose first drain pass saw its old restricted upsert before the trash page superseded it. That is truthful for that moment and was not changed.
- Finding 5 (legacy mixed-case tombstone) remains held pending PR #714 ownership confirmation.
- Other open gates: R51 F2/F3 follow-ups, Note B, live certification and rollout.
