# R51 low-fix coordinator verification attempt 1

Focused coordinator command from `ingestion/`:

```sh
.venv/bin/pytest -q tests/test_brain_minimum_provenance.py tests/test_flush_authority_outcome.py tests/test_drain_recovery.py tests/test_restriction_publication_recovery.py tests/test_document_restrictions.py tests/test_checkpoint_acknowledgment.py
```

Result: **64 passed, 14 failed in 2.37s**. All 14 failures are confined to new `test_brain_minimum_provenance.py`; every stack trace fails during test fixture setup because `_client` supplies fake `api_key="key"`, while existing `BrainClient.__init__` requires `aios_<key_id>_<secret>`. No test reached the behavior under test. The other five modules passed in this run. This is a test-fixture defect, not a production behavior result. Do not mark the new tests passing until rerun.

Exact bounded follow-up prompt: `r51-opus-followup-2-prompt.md`. Existing sole Opus writer should change only the fixture key to an existing-safe shape such as `aios_a_b`; no tests/commands. Then coordinator reruns this exact focused command.
