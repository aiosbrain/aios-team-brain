# AIO-1167 R51 low-fix coordinator verification — full sidecar

Focused suite from `ingestion/`:

```sh
.venv/bin/pytest -q tests/test_brain_minimum_provenance.py tests/test_flush_authority_outcome.py tests/test_drain_recovery.py tests/test_restriction_publication_recovery.py tests/test_document_restrictions.py tests/test_checkpoint_acknowledgment.py
```

Result: **78 passed in 2.31s**.

Full sidecar from `ingestion/`:

```sh
.venv/bin/pytest -q
```

Result: **957 passed, 28 skipped, 1 existing Starlette/httpx deprecation warning in 22.67s**. The suite ran through the normal approved loopback path. `git diff --check HEAD` also passed. This verifies the current full R50/R51 Python sidecar snapshot; TypeScript/Postgres production owners were not changed by the R51 Low fixes, and their previously recorded R50 checks remain applicable unless later review changes those owners.

Next: freeze the exact source-only patch and changed-path manifest, obtain a fresh Fable 5.1 delta review for the two adjudicated fixes, then obtain fresh blind Astra HIGH and GPT-6.1 Sol HIGH reviews. No release-readiness, merge or deployment claim.
