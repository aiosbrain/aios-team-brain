# R51 test-fixture follow-up result

- Model/session: `claude-opus-5-5` / `628402d5-a1c6-42b7-b736-e84358c1a749`; first-party (`apiKeySource=none`).
- Result: `success`, `is_error=False`, `2` turns, `25848` ms.
- Token metrics: uncached `4`, cache-read `732721`, cache creation `762209`, output `702`.
- Writer ran no commands or tests.

**What you asked for (R51 test fix):** in `test_the_end_of_run_flush_keeps_accumulated_progress_and_an_existing_cause`, pass `run_failure_counted=True` at the direct existing-cause call, with no production change and no weakened assertion.

The edit is in, uncommitted, and I ran nothing.

**Changed path:** `ingestion/tests/test_flush_authority_outcome.py` (the existing-cause call in that test only).

```diff
-    await _flush_restriction_evidence(_RefusingClient(code), execution, state, "account", caused, cause=cause)
+    await _flush_restriction_evidence(
+        _RefusingClient(code), execution, state, "account", caused, cause=cause,
+        run_failure_counted=True,  # the caller already charged this run (it set `failed=1` above)
+    )
```

**No other edits.** No production code changed. The assertions in that test, including `caused.failed == 1`, are unchanged. The no-cause control (which charges one failure), the test through the real binding catch, and all the new adjacent-correction tests are untouched.

The stray empty file `ingestion/tests/_r51_tail_placeholder.txt` from the previous turn is still there; please delete it before checkpointing.
