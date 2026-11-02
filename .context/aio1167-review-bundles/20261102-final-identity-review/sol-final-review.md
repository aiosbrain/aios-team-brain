# GPT-6.1 Sol final review — PR743 candidate `b86b22d2`

**Disposition: changes required; one Medium/P2 finding.** Review target `b86b22d2e6b1561d0f7e57e0a4caac07e9880fb3`, base `5ecd2989e21fded915b41b508477bb267aaec06d`.

## Preserve quota evidence returned by an abandoned watch worker

Trigger: a dispatched watch creation or stop exceeds its renewal worker deadline, or its awaiting coroutine is cancelled, then receives a Google quota response with a standing `Retry-After`.

`_Run.offload` abandons the worker and delivers its eventual result through `on_late` (`ingestion/aios_ingest/watch_renewal.py:190`). Creation supplies `_late_evidence`, but that callback discards every exceptional completion, including `WatchQuotaLimited` (`:256`). Stop supplies no late-result handler (`:437`). The normal quota catches and `hold_connection` writes (`:383`, `:445`, `:541`) are therefore never reached. The next poll or renewal can issue calls before Google's named deadline even though the process and SQLite remain available.

Regression: extend the controlled-deadline worker test to release an abandoned creation with `WatchQuotaLimited`, and add the corresponding stop case. Assert the late response journals the same-account hold, does not activate a channel or advance a cursor, and blocks subsequent polling/renewal until expiry. Cover cancellation as well as timeout. Existing quota tests deliver the error before abandonment.

No additional confirmed actionable defect was found in the inspected identity delta. SQL/JS identity equivalence, canonical-state precedence, exact revision-key evidence, both actual concurrency orderings, restriction persistence and watch lifecycle were reviewed. Static inspection only; no tests, edits, network/MCP, or review of another reviewer's results. This is not staging, merge, deployment, release or live-certification readiness.
