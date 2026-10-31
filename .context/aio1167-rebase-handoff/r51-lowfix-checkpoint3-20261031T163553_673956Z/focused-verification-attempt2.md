# R51 low-fix coordinator verification attempt 2

The exact focused command rerun after changing the fake API key in `test_brain_minimum_provenance.py`:

```sh
.venv/bin/pytest -q tests/test_brain_minimum_provenance.py tests/test_flush_authority_outcome.py tests/test_drain_recovery.py tests/test_restriction_publication_recovery.py tests/test_document_restrictions.py tests/test_checkpoint_acknowledgment.py
```

Result: **77 passed, 1 failed in 2.00s**. The sole failure is `test_a_brain_deferral_carries_only_the_brain_named_minimum[positive]`: independently serialized `_iso_after(delay)` and `_iso_after(named)` timestamps made `not_before` six microseconds earlier than `provider_not_before`. Local combined eligibility must never precede the provider minimum. No other focused failure occurred. The 77 passing tests are preserved but this suite is not yet green.

Next, resume the same Opus writer for a one-file correction: derive the local and provider deadline timestamps from one captured UTC clock in both `_backoff` and checkpoint deferral with a named minimum; preserve the strict ordering assertion. Then rerun the focused command.
