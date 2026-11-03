# Fable 5.1 final review — candidate cb5a2c48

Wrapping up: all 70 diff hunks and the dependent unchanged callers are inspected, and I'm now writing the verdict.

## Verdict

**Approve with design questions; no confirmed blocking defect found in the patch.** The code matches the accepted spec's addendum semantics in every area the diff touches. Live certification remains open, as `verification.md` states.

**Hash verification was not possible in this session.** The review tools exposed to me were Read, Glob and Grep only, so I could not compute SHA-256 digests for `full.diff`, `manifest.json` entries, `accepted-spec.md` or `AGENTS.md`. What I did verify structurally: the 70 `diff --git` headers in `full.diff` match the 70 manifest paths exactly, once each, with no extra or missing file. Treat the pinned hashes as supplied, unverified evidence.

## Confirmed defects

None at High or Medium. One Low diagnostics regression:

- **Post-push, non-latching checkpoint 4xx is no longer a counted or exhausting failure.** `ingestion/aios_ingest/gdrive_sync.py:3486-3502` now routes every non-terminal `BrainError` after an accepted push through the control-plane branch. A 409 or any sent-but-unacknowledged response latches and the run stops, which is correct. But a repeatable 400 or 422 on the checkpoint payload neither calls `_fail_work` nor increments `failed`, so the obligation never exhausts and `retry_exhausted` never surfaces. Trigger: brain rejects the checkpoint document deterministically, for example an oversized progress document after many `document_restrictions` items. Consequence: each run re-pushes the document, stops the drain, and reports only a category. Expected: a deterministic 4xx that is not `stale_progress` should still spend retry budget so it becomes actionable. Minimum regression: unit test asserting a 400 checkpoint response after push increments `failed` or exhausts after the bound.

## Design questions for adjudication

- **Unselected explicit-trash events now create durable removal obligations and sink calls.** `gdrive_sync.py:2693-2713` emits a `remove` obligation for any trashed Google Doc in the change feed, selected or not, by adjudication A1. The brain-side no-op is proven in `test/datamechanics/gdrive-audience-claims.datamechanics.test.ts` and the queue bound is tested. The cost: a bulk trash of unrelated documents the account can see fills `pending_work` ahead of later selected edits, since `list_pending` orders by attempts then creation time, and provider ids outside the selection are transmitted to the brain. A narrower rule would deliver membershipless trash only for streams in recovery or behind a restricted root, which is the case A1 was written for.
- **Unrepresentable or very long valid Retry-After holds with no override.** `sources/gdrive.py` holds an unrepresentable value at `LATEST_INSTANT` and never caps a valid one; the hold survives scope edits and same-account reconnects by design, and `docs/ARCHITECTURE.md` states no Admin override exists. A single injected `Retry-After: 99999999999` therefore removes the account from service permanently under AC-07's Run now and Retry controls. This is documented and tested, so it is a policy choice, but it conflicts with AC-04's "bound retry and backoff" intent and deserves an audited override or a disclosed cap.
- **Team-wide row locks on every Google email write.** `lockEquivalentGoogleEmailRows` in `lib/identity/member-identities.ts` locks all `gdrive` identity and state rows of the team `for update`. Correctness holds because every caller already serializes on the team identity authority, so this is contention only.

## Diagnostics and robustness observations

- `IngestSummary` is a plain dataclass, so the new private attributes stored through `__dict__` work, but they are invisible to `dataclasses.asdict` and `replace`. Fragile but not wrong today.
- A local-deadline deferral raised from `defer_root` inside `_enumerate_baseline` is still charged as `failed` by the stream handler. This predates the patch and is inconsistent with the R51 F7 rule applied on the drain and start-token paths.
- `removeMemberIdentity` accepts arbitrary bytes after `author-email:` for exact-spelling unlink. Deliberate per A5, Admin-only, delete-by-exact-match, so low risk.

## Verified behaviors worth recording

- Renewal's new restriction publications send the full acknowledged document plus restriction sections. This is safe because both `_Run.publish` and `_checkpoint_progress` refresh `execution.progress` from the acknowledgment and the brain's checkpoint is revision-conditional.
- `_observe_root` only raises `BrainError` or `ProviderDeferred`, so the new probe inside `_deferred_root_admissible` cannot leak an unclassified provider error.
- The file-root "unavailable" detail cannot be cleared by the change-page metadata read in practice: a lost file root has no membership, so `absence_withheld` is never reached for it, and restoration clears only after accepted ingestion.
- `mark_root_unresolved` never downgrades a bound root, and `_bind_selected_roots` skips already-bound roots, so the new deferral path applies only to never-bound roots.
- Migration `20261031140000` is `create or replace` only, mirrored in `schema.sql`, and later than every migration in this snapshot. Cross-branch reservation per `AGENTS.md` could not be checked from here.
- Admin test, Picker and manual-root verification all refresh through `refreshGdriveAdminAccess` under the broker's grant ceiling; the generic catches in `actions.ts` surface the sanitized `GdriveAuthorityError` message.

## Test gaps

- No test that unrelated trash volume does not starve later selected upserts of drain budget.
- No test for a deterministic non-409 4xx on the post-push checkpoint, which is the Low defect above.
- No real-HTTP tier test for the Admin refresh refusals reaching the browser as sanitized text; the data-mechanics tests cover the policy, not the action boundary.

## Spec coverage map

| Spec area | Patch coverage |
| -- | -- |
| AC-01, AC-07 | Admin refresh under broker policy; callback identity outcomes; held and paused reporting |
| AC-02 | Untouched by this patch |
| AC-03, AC-04 | Checkpoint uncertainty latch; Retry-After classification; account holds and resource restrictions bound to account, not generation; deferred roots, start tokens, folder listing and change-page minima; watch quota and operation minima |
| AC-05 | Explicit trash as document evidence; lost and restored roots; withdrawn support in a partial build |
| AC-06 | Claim-aware trash retirement; epoch unchanged for no-claim removals |
| AC-08, AC-09 | Canonical `author-email:` key; tombstone, ambiguity and preserved outcomes; exact-bytes unlink; repair nomination by the JavaScript contract |
| AC-10 | Readers hold the email bridge for unlinked or ambiguous Google identities |
| Live certification, soak | Open gates, not addressed by this patch |
