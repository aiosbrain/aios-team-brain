"""A quota answer delivered by an ABANDONED watch worker holds the account (AIO-1167 final review).

Spec (accepted-spec AC-04; combined final-review adjudication §3). ``_Run.offload`` abandons a worker
that is already running when its deadline passes or its waiting coroutine is cancelled. If that
worker later returns ``WatchQuotaLimited`` — from a channel creation or a stop — the answer is the
ACCOUNT's quota, exactly as a timely one is:

  * it is journaled, on the event loop that owns the StateStore, as a monotonic local hold for the
    verified account of the transport that made the call (captured at dispatch — never an older
    channel record's account), through the existing ``hold_connection`` owner;
  * once adopted, no further same-account watch call is made in the still-running sweep, a reopened
    StateStore keeps it, polling's admission and later sweeps honour it until expiry;
  * the late callback activates nothing, retires nothing, moves no cursor and publishes nothing: the
    next acquisition, holding fresh authority, publishes it;
  * a shorter late deadline never shortens a longer hold; another account, a worker that never
    started, a non-quota error and a late successful creation (cleanup evidence only) add no hold.

The controlled deadline replaces only ``watch_renewal._wait_bounded``; the worker pool, abandonment,
late-result delivery and publication are the production code.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import threading
import time
from concurrent.futures import Future
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from aios_ingest import watch_renewal
from aios_ingest.gdrive_sync import _standing_account_hold
from aios_ingest.state import StateStore, StreamKey
from aios_ingest.watch_lifecycle import (
    ACTIVE, CLEANUP_PENDING, DISPATCHED, UNCERTAIN, WatchQuotaLimited, from_section, to_section,
)
from test_watch_lifecycle import (
    ACCOUNT, INTEGRATION, SETTINGS, _conn, _controlled_deadline, _Provider, _record,
)
from test_watch_quota_hold import GEN, LONG, _hold, _near, _published_hold, _quota_brain

OTHER_ACCOUNT = "previous-account"


def _at(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _deferral(not_before: str) -> SimpleNamespace:
    """The polling owner's deferral as a watch quota answer carries it."""
    return SimpleNamespace(not_before=not_before, category="rate_limited", provider_deadline=True)


async def _until(condition, tries: int = 500) -> None:
    """Let the event loop run (and a worker's handed-back SQLite step land) until ``condition``."""
    for _ in range(tries):
        if condition():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("the condition never held")


class _LateQuotaProvider(_Provider):
    """Google, scripted: the FIRST call of ``kind`` ("watch" or "stop") blocks in its worker until the
    test releases it, then answers with the account's quota. Every call is recorded in ``calls``."""

    def __init__(self, brain, *, kind: str, not_before: str):
        super().__init__(brain)
        self.kind, self.not_before = kind, not_before
        self.entered, self.release = threading.Event(), threading.Event()
        self.calls: list[tuple[str, str]] = []
        self._answered = False

    def _call(self, kind: str, target: str) -> None:
        self.calls.append((kind, target))
        if kind == self.kind and not self._answered:
            self._answered = True
            self.entered.set()
            assert self.release.wait(10), "the test never released the provider call"
            raise WatchQuotaLimited(_deferral(self.not_before))

    def dispatch(self, record, *, page_token, verification_token, access_token=None,
                 provider_gate=None, deadline=None):
        self._call("watch", record.drive_id)
        return super().dispatch(record, page_token=page_token, verification_token=verification_token,
                                access_token=access_token, provider_gate=provider_gate, deadline=deadline)

    def stop(self, record, resource_id, *, access_token=None, provider_gate=None, deadline=None):
        self._call("stop", record.attempt_id)
        return super().stop(record, resource_id, access_token=access_token,
                            provider_gate=provider_gate, deadline=deadline)


def _hook_checkpoints(monkeypatch, hook) -> None:
    """Run ``hook(payload)`` (async) on every fenced checkpoint before the brain stores it."""
    base = watch_renewal.brain_client.BrainClient

    class Hooked(base):  # type: ignore[misc, valid-type]
        async def checkpoint_gdrive_execution(self, execution, payload):
            await hook(payload)
            return await super().checkpoint_gdrive_execution(execution, payload)

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Hooked)


def _records_in(payload) -> list[dict]:
    return list((payload.get("watches") or {}).get("records") or [])


# ------------------------------------------------------------------------------------------------ #
# Creation and stop, end to end through the renewal sweep
# ------------------------------------------------------------------------------------------------ #

@pytest.mark.asyncio
async def test_a_late_creation_quota_after_timeout_holds_the_account_and_stops_the_rest_of_the_sweep(
    tmp_path, monkeypatch,
):
    deadline_passed = _controlled_deadline(monkeypatch)
    brain = _quota_brain(due=True).install(monkeypatch)
    streams_before = copy.deepcopy(brain.progress["streams"])
    path = str(tmp_path / "late-create.sqlite")
    state = StateStore(path)
    provider = _LateQuotaProvider(brain, kind="watch", not_before=_at(int(LONG)))

    async def answer_once_its_outcome_is_unknown(payload):
        # The timed-out attempt is being published as unknown: only now does the abandoned worker
        # answer, and its quota evidence is adopted on this loop before the sweep goes on.
        if any(r["state"] == UNCERTAIN for r in _records_in(payload)) and not provider.release.is_set():
            provider.release.set()
            await _until(lambda: _hold(state) is not None)

    _hook_checkpoints(monkeypatch, answer_once_its_outcome_is_unknown)
    started = datetime.now(timezone.utc)
    sweep = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(provider.entered.wait, 10)
    deadline_passed.set()
    await sweep

    # One creation; once the hold stood, no second creation (shared-x) and no stop.
    assert provider.calls == [("watch", "my-drive")]
    held = _hold(state)
    assert held is not None and _near(held[0], started + timedelta(seconds=int(LONG)))
    assert _published_hold(brain) is None  # the late callback publishes nothing
    records = brain.records()
    (attempt,) = [r for r in records.values() if r.predecessor == "current"]
    assert attempt.state == UNCERTAIN  # never activated by the late answer
    assert [r.attempt_id for r in records.values() if r.state == ACTIVE] == ["current"]
    assert all(records[f"old{i}"].state == CLEANUP_PENDING for i in range(2))
    assert all(records[f"old{i}"].stop_attempts == 0 for i in range(2))
    assert brain.progress["streams"] == streams_before  # no cursor moved
    state.close()

    # Reopened: polling's admission and renewal both honour it; the fresh acquisition publishes it.
    state = StateStore(path)
    assert _standing_account_hold(state, INTEGRATION, GEN, ACCOUNT) is not None
    provider.calls.clear()
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert provider.calls == []
    assert _published_hold(brain) is not None and _published_hold(brain)[0] == _hold(state)[0]
    assert brain.progress["streams"] == streams_before
    state.close()


@pytest.mark.asyncio
async def test_a_late_creation_quota_after_cancellation_is_journaled_on_the_live_loop(tmp_path, monkeypatch):
    brain = _quota_brain(due=True).install(monkeypatch)
    streams_before = copy.deepcopy(brain.progress["streams"])
    path = str(tmp_path / "late-create-cancel.sqlite")
    state = StateStore(path)
    provider = _LateQuotaProvider(brain, kind="watch", not_before=_at(int(LONG)))

    sweep = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(provider.entered.wait, 10)
    sweep.cancel()
    with pytest.raises(asyncio.CancelledError):  # cancellation still propagates
        await sweep
    assert _hold(state) is None  # the worker has not answered yet

    provider.release.set()
    await _until(lambda: _hold(state) is not None)
    records = brain.records()
    (attempt,) = [r for r in records.values() if r.predecessor == "current"]
    assert attempt.state == DISPATCHED  # nothing published after cancellation, nothing activated
    assert _published_hold(brain) is None
    assert brain.progress["streams"] == streams_before
    state.close()

    state = StateStore(path)
    assert _standing_account_hold(state, INTEGRATION, GEN, ACCOUNT) is not None
    provider.calls.clear()
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert provider.calls == []  # recovery runs (no provider call); creation and cleanup are held
    assert brain.records()[attempt.attempt_id].state == UNCERTAIN
    assert _published_hold(brain) is not None
    state.close()


def _brain_with_older_account_cleanup():
    """Channels not due (no creation) and two to stop; ``old0`` was created under an OLDER account."""
    brain = _quota_brain(due=False)
    records = from_section(brain.progress)
    records["old0"] = dataclasses.replace(
        records["old0"], account_id=OTHER_ACCOUNT,
        namespace=StreamKey("demo", INTEGRATION, OTHER_ACCOUNT, "my-drive").namespace(GEN),
    )
    brain.progress["watches"] = to_section(records)
    return brain


@pytest.mark.asyncio
async def test_a_late_stop_quota_after_timeout_holds_the_current_transport_account_not_the_records(
    tmp_path, monkeypatch,
):
    deadline_passed = _controlled_deadline(monkeypatch)
    brain = _brain_with_older_account_cleanup().install(monkeypatch)
    streams_before = copy.deepcopy(brain.progress["streams"])
    state = StateStore(str(tmp_path / "late-stop.sqlite"))
    provider = _LateQuotaProvider(brain, kind="stop", not_before=_at(int(LONG)))

    async def answer_once_the_timeout_is_recorded(payload):
        old0 = next((r for r in _records_in(payload) if r["attempt_id"] == "old0"), None)
        if old0 and old0["stop_attempts"] == 1 and not provider.release.is_set():
            provider.release.set()
            await _until(lambda: _hold(state) is not None)

    _hook_checkpoints(monkeypatch, answer_once_the_timeout_is_recorded)
    sweep = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(provider.entered.wait, 10)
    deadline_passed.set()
    await sweep

    assert provider.calls == [("stop", "old0")]  # the second stop is never attempted
    assert provider.stopped == []
    assert _hold(state) is not None  # the verified account of the transport that stopped it
    assert _standing_account_hold(state, INTEGRATION, GEN, OTHER_ACCOUNT) is None  # not the record's
    records = brain.records()
    assert records["old0"].state == CLEANUP_PENDING and records["old1"].state == CLEANUP_PENDING
    assert records["old1"].stop_attempts == 0
    assert records["current"].state == ACTIVE and records["current-x"].state == ACTIVE
    assert _published_hold(brain) is None
    assert brain.progress["streams"] == streams_before
    state.close()


@pytest.mark.asyncio
async def test_a_late_stop_quota_after_cancellation_holds_the_account(tmp_path, monkeypatch):
    brain = _brain_with_older_account_cleanup().install(monkeypatch)
    path = str(tmp_path / "late-stop-cancel.sqlite")
    state = StateStore(path)
    provider = _LateQuotaProvider(brain, kind="stop", not_before=_at(int(LONG)))

    sweep = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(provider.entered.wait, 10)
    sweep.cancel()
    with pytest.raises(asyncio.CancelledError):
        await sweep
    provider.release.set()
    await _until(lambda: _hold(state) is not None)
    assert _standing_account_hold(state, INTEGRATION, GEN, OTHER_ACCOUNT) is None
    records = brain.records()
    assert records["old0"].state == CLEANUP_PENDING and records["old0"].stop_attempts == 0
    state.close()

    state = StateStore(path)
    provider.calls.clear()
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert provider.calls == []
    assert _published_hold(brain) is not None
    state.close()


# ------------------------------------------------------------------------------------------------ #
# The late-result owner itself: monotonic, scoped, and inert for everything but quota or evidence
# ------------------------------------------------------------------------------------------------ #

def _quota_future(not_before: str) -> Future:
    future: Future = Future()
    future.set_exception(WatchQuotaLimited(_deferral(not_before)))
    return future


@pytest.mark.asyncio
async def test_a_late_quota_answer_never_shortens_a_longer_hold_and_extends_a_shorter_one(tmp_path):
    state = StateStore(str(tmp_path / "monotonic.sqlite"))
    loop = asyncio.get_running_loop()
    deliver = watch_renewal._late_evidence(loop, state, None, hold=(INTEGRATION, GEN, ACCOUNT))
    longer, shorter, longest = _at(7200), _at(600), _at(86_400)
    state.hold_connection(INTEGRATION, GEN, ACCOUNT, longer, "rate_limited")

    deliver(_quota_future(shorter))
    await asyncio.sleep(0)
    assert _hold(state) == (longer, "rate_limited")  # never shortened

    deliver(_quota_future(longest))
    await asyncio.sleep(0)
    assert _hold(state) == (longest, "rate_limited")  # a longer late answer extends it
    state.close()


@pytest.mark.asyncio
async def test_a_late_hold_belongs_to_its_captured_account_and_outlives_a_generation_change(tmp_path):
    state = StateStore(str(tmp_path / "scoped.sqlite"))
    loop = asyncio.get_running_loop()
    watch_renewal._late_evidence(loop, state, None, hold=(INTEGRATION, GEN, ACCOUNT))(_quota_future(_at(3600)))
    await asyncio.sleep(0)

    assert _standing_account_hold(state, INTEGRATION, GEN, ACCOUNT) is not None
    # A later selection generation of the same verified account still honours it (R50 lifetime).
    assert _standing_account_hold(state, INTEGRATION, GEN + 1, ACCOUNT) is not None
    # Another account, and another connection, are not held.
    assert _standing_account_hold(state, INTEGRATION, GEN, OTHER_ACCOUNT) is None
    assert _standing_account_hold(state, "00000000-0000-0000-0000-0000000000b2", GEN, ACCOUNT) is None
    state.close()


@pytest.mark.asyncio
async def test_a_cancelled_nonquota_or_successful_late_result_adds_no_hold(tmp_path):
    state = StateStore(str(tmp_path / "inert.sqlite"))
    loop = asyncio.get_running_loop()
    record = _record(UNCERTAIN)
    state.save_watch_record(record)
    deliver = watch_renewal._late_evidence(loop, state, record, hold=(INTEGRATION, GEN, ACCOUNT))

    cancelled: Future = Future()
    cancelled.cancel()
    deliver(cancelled)
    failed: Future = Future()
    failed.set_exception(RuntimeError("provider exploded"))
    deliver(failed)
    await asyncio.sleep(0)
    assert _hold(state) is None
    assert state.watch_evidence("gd", record.attempt_id) is None

    # A late successful creation stays cleanup evidence — no activation, no hold.
    created: Future = Future()
    created.set_result({"id": record.attempt_id, "resourceId": "res-late"})
    deliver(created)
    await asyncio.sleep(0)
    assert state.watch_evidence("gd", record.attempt_id) == "res-late"
    assert state.list_channels("gd", active_only=True) == []
    assert _hold(state) is None
    state.close()


@pytest.mark.asyncio
async def test_a_worker_cancelled_before_it_started_journals_nothing(tmp_path, monkeypatch):
    """Both pool workers are busy, so the quota call is still queued when its deadline passes: it
    is cancelled before it ever runs, no late handler is attached, and no hold is invented."""
    deadline_passed = _controlled_deadline(monkeypatch)
    state = StateStore(str(tmp_path / "never-started.sqlite"))
    loop = asyncio.get_running_loop()
    run = watch_renewal._Run(
        None, SimpleNamespace(integration_id=INTEGRATION, generation=GEN), state, "demo",
        time.monotonic() + 60, {},
    )
    release = threading.Event()
    busy = [watch_renewal._POOL.submit(release.wait, 10) for _ in range(2)]
    ran: list[int] = []

    def quota_call():
        ran.append(1)
        raise WatchQuotaLimited(_deferral(_at(3600)))

    try:
        pending = asyncio.create_task(run.offload(
            quota_call,
            on_late=watch_renewal._late_evidence(loop, state, None, hold=(INTEGRATION, GEN, ACCOUNT)),
        ))
        await asyncio.sleep(0)
        deadline_passed.set()
        with pytest.raises(watch_renewal.WatchStepTimeout) as timed_out:
            await pending
        assert timed_out.value.started is False
    finally:
        release.set()
        for future in busy:
            future.result(10)
    await asyncio.sleep(0.05)
    assert ran == []
    assert _hold(state) is None
    state.close()
