I'll locate the review packet (delta.diff, manifest, spec, adjudication context, verification) and then read the diff against the surrounding code.**Prompt restated:** Fable 5.1 read-only correction review of the AIO-1167 R51 stop-deadline delta, `f3c4d3cb` → `b6628c3e`, against the accepted spec, AGENTS.md, the prior adjudication and verification.md, assessing the absolute stop-deadline guard and its tests against the adjudicated cases, with a CLEAN / CHANGES REQUIRED verdict.

## Verdict: CLEAN

Reviewed exact candidate `b6628c3ed0f252d58259345c24178c75e4be9b16` via the manifest's `fable-delta/delta.diff` (SHA-256 `01e77897f471817eeae790a0de0b46e655ec12c2b3c5fca2980c8c6f8e364ac5`). The worktree source for the inspected hunks matches the diff's post-image. No files edited, no commands or tests run. Production certification and the 24-hour soak are not inferred; verification.md states both remain open.

**Adjudicated cases, each checked against code and a test that drives it:**

- **Guard immediately before execute.** `gdrive_watch.py:185-192`: service, request, composed gate (authority then admission), deadline check, then execute. Nothing sits between the check and the request. Pinned at -1/0/+1 s by the lifecycle unit test, plus the slow-setup case.
- **Authority refusal precedence.** The gate's `BrainError` propagates raw with no wrapping in `stop`. Pinned by the unit test where the refusal lands after the deadline and by the `authority-failure-wins` sweep case.
- **Timeout is not confirmed dispatch.** `watch_renewal.py:745-753` returns on `WatchStepTimeout` without publish, bump or projection. The four-phase sweep test and the in-flight test assert zero checkpoints, the acknowledged `(cleanup_pending, res-old0, 0)` triple in brain, every payload and the local row.
- **Late admitted-after-deadline stop.** The sweep test with `advance_past()` plus a 10 s ask timeout forces the successful-admission path, so only the manager guard can refuse. Asserted `drive.calls == []`, one authority check, nothing published.
- **Sent-before-deadline stays pending; late restrictions stay local.** Late success retires nothing, late quota becomes a local hold only, late minimum is journaled but absent from published restrictions. Never resent within the run.
- **Unanswered initial/final admission.** Stop: zero executes, cleanup ends, `gate.checks` distinguishes the two phases. Create: retires as `not dispatched: admission could not be confirmed`, the other creation and both stops proceed.
- **Spent slot, independent continuation.** `cleanups=3` budget-2 case: old0's refused slot is not refunded, old1 is stopped on a channel minimum, old2 waits.
- **Fixture realism.** `_absolute_deadline` freezes the `time` both modules read and moves it past the run deadline; publication is refused by the production `bounded()`, not by a scripted checkpoint. The old release-on-bumped-checkpoint hook is gone.
- **Timely accounting unchanged.** 404 → return (direct manager test), success → `retired/stopped` (sweep tests), 5xx-stop → `stop_attempts == 1` (quota-hold and operation-minima suites). None of these paths changed in the delta.

**One non-blocking finding (LOW):**

- `ingestion/tests/test_watch_late_quota.py:892` and `:914` (`_assert_cleanup_ended_untouched` callers). **Trigger:** delete either new handler at `watch_renewal.py:740-744` or `:745-753`. **Impact:** every assertion stays green, because the generic handler's bump publish is refused by `bounded()` at the same frozen deadline and the escaping exception is swallowed at `watch_renewal.py:875-877`. The handlers are correct and close a real sub-resolution race, but nothing pins their presence. **Correction:** add `caplog` to the sweep tests and assert no `Drive watch renewal for gd stopped:` warning was emitted, so an end-of-cleanup that escapes as an exception reddens.

**Out-of-delta note, not required for this correction:** a `_service` failure inside `stop` (config `ValueError`, missing extra) still reaches the generic handler and spends a stop attempt. `dispatch` wraps the same failures as `WatchNotDispatched`. Pre-existing and not adjudicated. If it is ever aligned, the new `WatchNotDispatched` handler would need to `continue` rather than `return`, since that failure is not a deadline signal.
