**What you asked for (R51 ordering fix):** in `brain_client.py` only, compute both timestamps of a deferral from one captured `now`, so the combined retry time can never come before the brain-named minimum.

That's done; the change is uncommitted and I ran nothing.

**Changed path:** `ingestion/aios_ingest/brain_client.py`
- `_iso_after(seconds, *, now=None)` now accepts an optional captured `now`. Without it, it behaves exactly as before.
- **`_backoff`:** when it defers, it captures `now` once and computes both `not_before` and `provider_not_before` from it.
- **Checkpoint deferral:** the branch that raises with the response does the same. The minimum is still set only when the brain named a delay (`server_delay` present).

Since `delay` is either the named delay plus jitter or the fallback plus jitter, it is always at least the named delay. So `not_before >= provider_not_before` now holds by construction. A valid zero is still recorded, and a missing minimum stays missing. The time slept, the jitter, the lost-acknowledgment deferral and `_timeout_backoff` are unchanged.

**Regression:** the existing assertion in `test_brain_minimum_provenance.py::test_a_brain_deferral_carries_only_the_brain_named_minimum` (`_at(deferral.not_before) >= minimum`) is kept unchanged, with no tolerance added. No other file changed.
