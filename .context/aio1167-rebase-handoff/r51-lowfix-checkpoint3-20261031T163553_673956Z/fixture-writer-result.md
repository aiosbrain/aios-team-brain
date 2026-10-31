**What you asked for (R51 fixture fix):** change only the API key in the `_client` helper of `test_brain_minimum_provenance.py` to a valid fake `aios_`-prefixed key.

That's done; the change is uncommitted and I ran nothing.

**Changed path:** `ingestion/tests/test_brain_minimum_provenance.py`, in `_client` (the only place the file builds a `BrainClient`).

```diff
-        "http://brain", "key", "team", sleep=sleep, random_fn=lambda: 0.0, monotonic_fn=lambda: clock["t"],
+        "http://brain", "aios_a_b", "team", sleep=sleep, random_fn=lambda: 0.0, monotonic_fn=lambda: clock["t"],
```

Nothing else changed: no production code, assertions, other tests or acceptance map.
