
Initial focused run: `.venv/bin/pytest -q tests/test_flush_authority_outcome.py` — 16 passed, 2 failed. Both failures are the two authority-code cases of the direct helper control `test_the_end_of_run_flush_keeps_accumulated_progress_and_an_existing_cause`; this fixture did not pass the new explicit `run_failure_counted=True` state, while it asserts a previously charged run. New no-streams, selection-unresolved, active-drain and document-failure cases passed in this run. Do not treat the adjacent slice as verified until the fixture is corrected and the focused suite is green.

Bounded follow-up prompt is `r51-opus-test-fixture-followup-prompt.md`; same writer only, no production changes.
