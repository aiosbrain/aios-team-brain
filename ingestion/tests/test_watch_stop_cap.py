"""One exhausted cleanup record never ends the sweep (AIO-1167 R83 F2).

Spec (Astra R83 adjudication F2). Cleanup stops channels in ``attempt_id`` order, so a record whose stop
attempts reached ``MAX_STOP_ATTEMPTS`` sorts FIRST on every later sweep. Its cap is THAT record's state,
not the sweep's: it is left exactly as it is — attempts, evidence, state, no stop slot spent — for the
existing expiry handling, and the eligible records after it are still stopped. Only the sweep-wide
stop budget, the run deadline and an account hold end cleanup. Through the real ``renew_watches``:

  * ``old0`` reaches its cap in one sweep (a failed stop), then later sweeps leave it untouched while
    ``old1`` is stopped and retired; ``old0`` already at cap from the start behaves the same;
  * zero-call controls: an exhausted stop budget, a spent run deadline and a standing account hold make
    no stop call at all — not even for the eligible record.
"""

from __future__ import annotations

import pytest

from aios_ingest import watch_renewal
from aios_ingest.state import StateStore
from aios_ingest.watch_lifecycle import CLEANUP_PENDING, RETIRED, from_section, to_section
from test_watch_account_hold import _publish_hold
from test_watch_lifecycle import ACCOUNT, SETTINGS, _conn
from test_watch_quota_hold import _fake_drive, _GoogleError, _manager, _quota_brain

CAP = watch_renewal.MAX_STOP_ATTEMPTS


def _brain(monkeypatch, *, old0_attempts: int):
    brain = _quota_brain(due=False)
    records = from_section(brain.progress)
    records["old0"] = records["old0"].__class__(**{**records["old0"].__dict__, "stop_attempts": old0_attempts})
    brain.progress["watches"] = to_section(records)
    return brain.install(monkeypatch)


def _stops(fake):
    return [call for call in fake.calls if call[0] == "stop"]


@pytest.mark.parametrize("start", ["reaches-cap", "at-cap"])
@pytest.mark.asyncio
async def test_an_exhausted_record_is_left_untouched_and_the_next_record_is_still_retired(
    tmp_path, monkeypatch, start,
):
    fake = _fake_drive(monkeypatch)
    brain = _brain(monkeypatch, old0_attempts=CAP - 1 if start == "reaches-cap" else CAP)
    state = StateStore(str(tmp_path / f"cap-{start}.sqlite"))

    if start == "reaches-cap":
        # The transition sweep: old0's last allowed stop fails (it reaches the cap), and old1's stop
        # fails too, so old1 is still owed when old0 first sorts ahead of it AT the cap.
        fake.stop_answers = [_GoogleError(500), _GoogleError(500)]
        await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
        assert _stops(fake) == [("stop", "old0"), ("stop", "old1")]
        records = brain.records()
        assert records["old0"].stop_attempts == CAP and records["old0"].state == CLEANUP_PENDING
        assert records["old1"].stop_attempts == 1 and records["old1"].state == CLEANUP_PENDING

    old0 = brain.records()["old0"]
    for sweep in range(3):
        fake.calls.clear()
        await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
        assert ("stop", "old0") not in fake.calls, f"sweep {sweep}: the exhausted record is never stopped again"
        assert brain.records()["old0"] == old0, f"sweep {sweep}: attempts, evidence and state are kept as they are"
        if sweep == 0:
            assert _stops(fake) == [("stop", "old1")], "the eligible record after it is still stopped"
        else:
            assert _stops(fake) == [], "nothing left to stop"
    assert brain.records()["old1"].state == RETIRED
    state.close()


@pytest.mark.parametrize("control", ["stop-budget", "run-deadline", "account-hold"])
@pytest.mark.asyncio
async def test_zero_call_controls_still_end_the_sweep_before_any_stop(tmp_path, monkeypatch, control):
    fake = _fake_drive(monkeypatch)
    brain = _brain(monkeypatch, old0_attempts=CAP)
    if control == "stop-budget":
        budget = watch_renewal._Budget
        monkeypatch.setattr(watch_renewal, "_Budget", lambda **kwargs: budget(**{**kwargs, "stops": 0}))
    elif control == "run-deadline":
        monkeypatch.setattr(watch_renewal._Run, "remaining", lambda self: 0.0)
    else:
        _publish_hold(brain, ACCOUNT)
    state = StateStore(str(tmp_path / f"control-{control}.sqlite"))
    before = brain.records()

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    assert _stops(fake) == [], "no stop call — not even for the eligible record"
    assert {key: before[key] for key in ("old0", "old1")} == {key: brain.records()[key] for key in ("old0", "old1")}
    state.close()
