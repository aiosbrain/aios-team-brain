# R51 low-fix coordinator verification attempt 3

Focused command from `ingestion/`:

```sh
.venv/bin/pytest -q tests/test_brain_minimum_provenance.py tests/test_flush_authority_outcome.py tests/test_drain_recovery.py tests/test_restriction_publication_recovery.py tests/test_document_restrictions.py tests/test_checkpoint_acknowledgment.py
```

Result: **78 passed in 2.31s**. This includes both new R51 Low regression modules plus existing drain/restriction/checkpoint controls. The corrected fake API key now reaches every test, and the paired UTC construction keeps the positive local eligibility at or after its provider minimum without tolerance. No failures or skips were reported.

This is the focused set only. The full sidecar suite and broader cross-owner checks remain pending; do not treat focused success as a final snapshot or release gate.
