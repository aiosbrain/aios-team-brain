"""Watch renewal overlaps the old channel under the configured sweep (AIO-1167 R44 C8).

Spec (AC-04 overlap). With the default 1800 s sweep, a channel is admitted for renewal early enough
that the sweep which renews it starts at least the safety skew before expiry, whatever the phase of
the sweep clock relative to the expiry — the old skew-only window let a sweep 11 minutes out skip it
and the next arrive after expiry. A channel Google gave a lifetime shorter than one interval gets a
catch-up sweep scheduled before it expires. (The successor-before-predecessor publication order and
the old channel surviving a failed renewal are covered by the lifecycle tests.)
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from aios_ingest.scheduler import _schedule_catch_up_renewal
from aios_ingest.state import Channel, StateStore
from aios_ingest.watch_renewal import (
    DEFAULT_SWEEP_SECONDS,
    RENEWAL_SKEW_SECONDS,
    WATCH_RUN_SECONDS,
    _due,
    renewal_window_seconds,
)

EXPIRY = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)


def _first_due_sweep(phase_seconds: float, sweep_seconds: float, due) -> datetime | None:
    """The first sweep (every ``sweep_seconds``, offset by ``phase_seconds``) at which ``due`` holds."""
    start = EXPIRY - timedelta(days=7) + timedelta(seconds=phase_seconds)
    at = start
    while at < EXPIRY:
        if due(at):
            return at
        at += timedelta(seconds=sweep_seconds)
    return None


def test_the_window_is_interval_plus_run_budget_plus_skew():
    assert renewal_window_seconds(DEFAULT_SWEEP_SECONDS) == DEFAULT_SWEEP_SECONDS + WATCH_RUN_SECONDS + RENEWAL_SKEW_SECONDS


@pytest.mark.parametrize("sweep_seconds", [DEFAULT_SWEEP_SECONDS, 600, 3600])
def test_every_sweep_phase_renews_with_the_skew_still_ahead(sweep_seconds):
    for phase in range(0, int(sweep_seconds), 37):
        renewing = _first_due_sweep(phase, sweep_seconds, lambda at: _due(EXPIRY.isoformat(), at, sweep_seconds))
        assert renewing is not None, phase
        # The run that renews starts with at least one run budget plus the skew still ahead.
        assert (EXPIRY - renewing).total_seconds() >= WATCH_RUN_SECONDS + RENEWAL_SKEW_SECONDS, phase


def test_the_old_skew_only_window_could_miss_expiry_entirely():
    def skew_only(at):
        return (EXPIRY - at).total_seconds() <= RENEWAL_SKEW_SECONDS

    missed = [phase for phase in range(0, DEFAULT_SWEEP_SECONDS, 60)
              if _first_due_sweep(phase, DEFAULT_SWEEP_SECONDS, skew_only) is None]
    assert missed  # the defect this replaces: some phases never renewed before expiry


class _Scheduler:
    def __init__(self):
        self.jobs = []

    def add_job(self, func, trigger, **kwargs):
        self.jobs.append((trigger, kwargs))


def test_a_lifetime_shorter_than_one_interval_gets_a_catch_up_sweep_before_expiry(tmp_path):
    state = StateStore(str(tmp_path / "short.sqlite"))
    expiry = datetime.now(timezone.utc) + timedelta(minutes=20)
    state.save_channel(Channel("docs", "chan", "res", expiry.isoformat(), "ns", "hash"))
    scheduler = _Scheduler()
    _schedule_catch_up_renewal(state, object(), [], None, DEFAULT_SWEEP_SECONDS, scheduler,
                               lead_seconds=WATCH_RUN_SECONDS + RENEWAL_SKEW_SECONDS)
    [(trigger, job)] = scheduler.jobs
    assert trigger == "date" and job["id"] == "renewal-catch-up" and job["replace_existing"] is True
    assert job["run_date"] <= expiry - timedelta(seconds=RENEWAL_SKEW_SECONDS)
    state.close()


def test_no_catch_up_when_the_regular_sweep_is_early_enough(tmp_path):
    state = StateStore(str(tmp_path / "long.sqlite"))
    state.save_channel(Channel("docs", "chan", "res", (datetime.now(timezone.utc) + timedelta(days=2)).isoformat(), "ns", "hash"))
    scheduler = _Scheduler()
    _schedule_catch_up_renewal(state, object(), [], None, DEFAULT_SWEEP_SECONDS, scheduler,
                               lead_seconds=WATCH_RUN_SECONDS + RENEWAL_SKEW_SECONDS)
    assert scheduler.jobs == []
    state.close()
