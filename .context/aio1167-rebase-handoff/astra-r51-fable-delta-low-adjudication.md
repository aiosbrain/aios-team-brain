# Astra adjudication — R51 Fable delta Low notes

Snapshot base: `5ecd2989e21fded915b41b508477bb267aaec06d`. Supplied patch SHA-256: `c09abf59b6a6d30993088321da612e1d384365ffad8d87bcb100cac2b715dfbe`. This is a read-only adjudication; the patch identity was supplied rather than recomputed by Astra.

## Note A — ACCEPT/FIX (Low)

The binding catch increments `failed` once at `gdrive_sync.py:1504–1505`, then the terminal authority refusal during flush increments it again at `:448–450` because the authority category is new. The existing-cause regression in `test_flush_authority_outcome.py:199–202` therefore reports `failed=2` for one run. `brain_client.py:526` reports that count unchanged, and `engine.py:42–50` uses it in the document total. AC-07 requires accurate counts (`accepted-spec.md:262,335`). Retain the original cause and add the distinct authority/unpublished categories without charging the same terminating run twice. Preserve the no-cause path's single failure charge; do not globally cap `failed` or infer that any existing document failure replaces the authority-run charge.

Required regression: extend the existing-cause case for both authority codes to assert `caused.failed == 1`, original category unchanged, authority category once, unpublished category once. Keep no-cause `failed == 1` and accumulated-progress controls; preferably exercise the actual binding catch to verify caller/helper accounting.

## Note B — ACCEPT/DEFER (Low reporting refinement)

The authority-lost drain return at `gdrive_sync.py:1713–1717` exits before local backlog measurement at `:1820–1843`. It retains the local hold, progress, hold diagnostics and authority refusal, and prevents later stream/checkpoint activity. Existing policy classifies refusal with failures, no completed work and unknown backlog as `failed` (`scheduler.py:378–406`); prior Astra instruction says follow existing classification instead of forcing `partial`. R51 acceptance requires immediate return and `partial` beside progress. AC-07 allows unknown backlog but forbids claiming zero. No parity requirement mandates reading local backlog after authority loss. Optional follow-up may measure it locally while retaining unknown if roster completeness is unavailable. No correction required now.

## Disposition

Fix only Note A before blind final reviews. Note B remains deferred. Neither finding is High/Medium. Keep R49 F6, H2, M-b/M-c/M-d, live Google certification/soak, opt-in/runner proof, canary and rollback open. No whole-branch readiness claim. No edits, tests, commands or workers were performed during adjudication.
