# Astra adjudication — Fable R51 deadline review

Candidate: `b6628c3ed0f252d58259345c24178c75e4be9b16`; Fable session `ea3748d7-d552-44ac-86b4-8fb462362d25`; exact Fable report: `r51-fable-deadline-review-20261103/review-report.md`.

## Decision 1 — ACCEPT (LOW): pin explicit deadline cleanup handling

Evidence: `ingestion/tests/test_watch_late_quota.py:849–916,920–948` asserts persisted outcomes, but removing either explicit exception handler in `ingestion/aios_ingest/watch_renewal.py:740–753` reaches `_bump_stop`/publish at `:766–767`. At the frozen deadline, `bounded()` at `:210–215` refuses publication and `_renew_connection():875–877` swallows the exception after warning, so state assertions alone still pass.

Required correction: in the deadline sweep cases, capture logs and assert no warning from the watch renewal module with prefix `Drive watch renewal for gd stopped:` during the first sweep, before the recovery sweep. Filter on logger and prefix; unrelated logs may remain. Existing deterministic fixtures have no outstanding operation minimum causing unrelated publication.

## Decision 2 — ACCEPT: known pre-dispatch service setup errors must not spend provider-failure attempts

The accepted prior adjudication says: “Keep provable pre-request failures outside failed-provider-attempt accounting” (`.context/aio1167-review-bundles/r51-stop-deadline-final-20261103-b6628c3e/fable-delta/prior-adjudication-context.txt:28`). `_service` raises `MissingExtraError` (`gdrive_watch.py:94–99`) or credential `ValueError` (`:106–110`) before `stop` creates/executes the request (`:185–192`). These currently fall into generic failed-attempt accounting in `watch_renewal.py:766–767`; a timely setup failure can eventually exhaust `MAX_STOP_ATTEMPTS` without sending a stop.

Required correction: translate only these known `_service(deadline)` setup failures at the boundary into a pre-dispatch refusal. Handle them without publication or attempt increment, and continue to other independent channels. The next loop iteration already enforces the absolute deadline and remaining budget; preserve the single deducted slot and do not retry the same channel during the sweep. Do not broadly catch authority-gate or execute exceptions. Preserve raw `BrainError`, `_StopNotSent` scoping, provider quota/minimum classification, timely success/404 accounting, and create semantics.

Required regression: use the production configured manager; parameterize the two setup errors for old0 with three cleanup channels and two slots. Assert no old0 execution; unchanged brain state/resource/attempt count, all payloads and local projection; old1 successfully stopped; old2 untouched. Retain existing authority-precedence, deadline, timely success/404 and actual provider-failure tests.

A broader family of unexpected router/request-construction errors is outside this narrow decision. Production Google certification and the 24-hour soak remain open. No edits/tests were made during adjudication.
