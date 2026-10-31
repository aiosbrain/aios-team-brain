# AIO-1167 R48 writer result — D1/D2 (Opus 5.5 HIGH, sole writer)

Prompt: `r48-opus-d1-d2-prompt.md`. Adjudication verified at SHA-256 `013839ddbe1f0607120f0c85ea8220752e343f78ddf50f24f84609bd813abb2c`. Writer session `628402d5-a1c6-42b7-b736-e84358c1a749`. No commit, push, PR change, review dispatch, merge or deployment. Source changes are left uncommitted on top of the R47 working tree. Acceptance detail: `r48-acceptance-mapping.md`.

Snapshot: HEAD `5ecd2989e21fded915b41b508477bb267aaec06d` + working tree. Non-`.context` tracked diff 20 files, +823/−181, SHA-256 `6b224debd0929032bc382424cf8019e18632c51f2aec1af255644831f61f3875`. Untracked tests:
- `ingestion/tests/test_account_hold_before_streams.py`
- `ingestion/tests/test_bound_root_loss.py`
- `ingestion/tests/test_checkpoint_acknowledgment.py`
- `ingestion/tests/test_checkpoint_uncertainty_latch.py`
- `ingestion/tests/test_exhaustion_is_not_completion.py`
- `ingestion/tests/test_retry_after_holds.py`
- `ingestion/tests/test_retry_after_parsing.py`
- `test/datamechanics/gdrive-admin-grant-policy.datamechanics.test.ts`
- `test/datamechanics/gdrive-identity-tombstone-email.datamechanics.test.ts`

No `.context`-independent copy of the R47 checkpoint was available locally, so the R48-only paths are listed below.

## R48 changed paths
Production:
- `ingestion/aios_ingest/sources/gdrive.py` (D2):
  - adds `parse_retry_after`/`RetryAfter`/`LATEST_INSTANT` and `ProviderDeferred.diagnostic`;
  - `_retry_after_header` is split out;
  - `_retry_after` is now a valid-only wrapper;
  - `_provider_call` classifies the header and represents the deadline exactly.
- `ingestion/aios_ingest/gdrive_sync.py`:
  - D2: `_ProviderAdmissionClosed.diagnostic`; `_count_retry_after_diagnostic` at each deferral site; the drain's per-document deferral passes the provider's `not_before`.
  - D1: an unavailable-root set in `_enumerate_baseline` (folder: no listing, traversal closed empty; bound file 404: page committed empty), plus `_ROOT_UNAVAILABLE_DETAIL`.
- `ingestion/aios_ingest/state.py` (D1): `record_root_unavailable`; `settle_root` also clears a bound root's unavailable detail.
- `docs/ARCHITECTURE.md`: D1 and D2 map prose.

Tests:
- New: `ingestion/tests/test_retry_after_parsing.py` (78), `ingestion/tests/test_retry_after_holds.py` (25), `ingestion/tests/test_bound_root_loss.py` (10).
- Extended harnesses, with no existing assertion changed:
  - `ingestion/tests/test_account_hold_before_streams.py` gains `provider_deferral`, which takes the deferral from the REAL provider owner for an HTTP status + Retry-After, and a `body` failure phase.
  - `ingestion/tests/test_gdrive_upgrade.py` `_DriveWorld` gains an opt-in `missing_folder_listing_404`, default off.

## Commands and results (writer, 2026-10-31)
- `cd ingestion && .venv/bin/python -m pytest tests/test_retry_after_parsing.py tests/test_retry_after_holds.py -q` → 103 passed.
- `.venv/bin/python -m pytest tests/test_bound_root_loss.py -q` → 10 passed.
- `.venv/bin/python -m pytest tests -q` (full sidecar suite) → **855 passed, 28 skipped**.
- `npm run check:docs` → congruent. `git diff --check` → clean. NUL-byte scan of changed/untracked files → none.
- Mutation checks: all mutants turned their targeted tests red, and the source was restored byte-identical (`cmp`).
  - D2 (6): permissive float 53; unrepresentable-as-fallback 18; cap at 3600 s 6; document ignores the deadline 2; no hold diagnostic 12; year check removed 5.
  - D1 (6): list the lost folder 3; file 404 unhandled 1; any error is loss 4; listing 404 as loss 1; restore keeps detail 1; no folder record 3.
- Not run this round: TypeScript checks and vitest/data-mechanics/HTTP tiers. No brain/TS file changed in R48; the R47 TS results stand as reported in `r47-opus-r46-corrections-result.md`. Python has no configured linter.

## Behaviour notes for review
- **D2:** valid long holds are kept exactly, with no cap, no Run-now bypass and no operator override (deferred by Astra). A long valid hold is therefore a real operational limitation, documented in the map.
- **D2, unrepresentable:** a valid but unrepresentable wait is held at `9999-12-31T23:59:59.999999+00:00` with an explicit diagnostic. That is the fail-closed representation; it is technically earlier than the impossible named instant, but no retry can occur before it in practice.
- **D2, document phase:** a non-quota deferral now keeps the provider's named deadline as its earliest retry. Previously the drain dropped `not_before` and used backoff alone. This is the one place a valid delay could have been retried early.
- **D1, run count:** a tombstone-seeded rescan completes on the following run, which is the existing protocol. The lost root stays `bound` (not a new state) so the brain's coverage owner and the evidence parser are unchanged. Its outcome is durable through committed empty pages plus the detail in the fenced `roots` evidence, and a fresh state file re-derives it from the root's own 404.
- **D1, removal:** the positive tombstone removal of documents final under the lost root still flows through the existing claim-aware path, so another connection's claim survives.
- **Earlier test-quality note:** the aliasing note on `test_account_hold_phases.py` from R47 still stands, and is unchanged.

Remaining gates: Fable delta review, blind Astra HIGH and GPT-6.1 Sol HIGH reviews of the exact snapshot; H2, M-b/M-c/M-d, live Google certification and rollout.
