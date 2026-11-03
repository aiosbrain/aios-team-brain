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
    started, a non-quota error and a late successful creation (cleanup evidence only) add no hold;
  * a late quota hold or creation minimum that lands while a NEW creation's PREPARED or DISPATCHED
    publication is blocked — or while its admitted request is queued behind the abandoned worker —
    prevents that request (R51 AC-04): the attempt retires as not dispatched, a failed retirement
    publication leaves the acknowledged record to normal recovery, and the drive is eligible again
    only after the deadline;
  * the same restriction landing while the production manager's live authority check blocks — for a
    creation or a cleanup stop — still prevents that request: a refused stop is provably unsent and
    leaves its channel cleanup_pending with its stop attempts; a failing authority check still wins.

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
from aios_ingest.brain_client import BrainError
from aios_ingest.gdrive_sync import _standing_account_hold
from aios_ingest.state import StateStore, StreamKey
from aios_ingest.watch_lifecycle import (
    ACTIVE, CLEANUP_PENDING, DISPATCHED, PREPARED, RETIRED, UNCERTAIN, WatchProviderMinimum,
    WatchQuotaLimited, from_section, to_section,
)
from test_watch_lifecycle import (
    ACCOUNT, INTEGRATION, SETTINGS, _conn, _controlled_deadline, _Provider, _record,
)
from test_watch_quota_hold import (
    GEN, LONG, _fake_drive, _hold, _local_watch_state, _manager, _near, _published_hold, _quota_brain,
)

OTHER_ACCOUNT = "previous-account"


def _at(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def _deferral(not_before: str) -> SimpleNamespace:
    """The polling owner's deferral as a watch quota answer carries it."""
    return SimpleNamespace(not_before=not_before, category="rate_limited", provider_deadline=True)


def _minimum(seconds: int = 86_400) -> SimpleNamespace:
    """The shared parser's non-quota provider minimum as a watch call carries it — the same shape as
    ``test_watch_operation_minima._minimum``, defined here because that module imports from this one."""
    return SimpleNamespace(
        not_before=(datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(),
        category="provider_unavailable", provider_deadline=True, diagnostic=None,
    )


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


# ------------------------------------------------------------------------------------------------ #
# A late restriction that lands while a NEW creation is between admission and dispatch (R51 AC-04)
# ------------------------------------------------------------------------------------------------ #

class _LateAnswerProvider(_LateQuotaProvider):
    """Google, scripted: the FIRST creation blocks in its worker until released, then raises ``error``
    — the account's quota or a named minimum for creating on that drive. Later calls succeed."""

    def __init__(self, brain, error):
        super().__init__(brain, kind="watch", not_before="")
        self.error = error

    def _call(self, kind: str, target: str) -> None:
        self.calls.append((kind, target))
        if kind == self.kind and not self._answered:
            self._answered = True
            self.entered.set()
            assert self.release.wait(10), "the test never released the provider call"
            raise self.error


def _late_answer(answer: str):
    if answer == "quota":
        return WatchQuotaLimited(_deferral(_at(int(LONG))))
    return WatchProviderMinimum(_minimum(int(LONG)))


def _restriction(state, answer: str):
    """The restriction the late answer journals: the account's hold, or my-drive's creation minimum."""
    if answer == "quota":
        return _hold(state)
    return state.document_restrictions(INTEGRATION, GEN, ACCOUNT).get("watch-create:my-drive")


async def _abandon_first_creation(state, provider):
    """Sweep 1: its my-drive creation blocks in a worker and the sweep is cancelled around it — the
    worker keeps running, abandoned, with the production late-result handler attached."""
    first = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(provider.entered.wait, 10)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    (abandoned,) = [r for r in provider.brain.records().values() if r.predecessor == "current"]
    assert abandoned.state == DISPATCHED
    return abandoned


@pytest.mark.parametrize("retirement", ["published", "publication-fails"])
@pytest.mark.parametrize("answer", ["quota", "minimum"])
@pytest.mark.parametrize("boundary", [PREPARED, DISPATCHED])
@pytest.mark.asyncio
async def test_a_restriction_journaled_while_a_creation_publication_is_blocked_prevents_its_dispatch(
    tmp_path, monkeypatch, boundary, answer, retirement,
):
    """A fresh sweep admits a my-drive creation, then waits on its PREPARED or DISPATCHED publication.
    Meanwhile the abandoned worker of the cancelled sweep answers and its restriction is journaled on
    this loop. When the publication resumes, admission is decided again: no request is sent, and the
    attempt retires as provably not dispatched. If that retirement cannot be published, the last
    acknowledged record stands and the next sweep recovers it normally. The predecessor and every
    cursor are untouched; the restriction persists and is honoured until its deadline only."""
    error = _late_answer(answer)
    brain = _quota_brain(due=True).install(monkeypatch)
    streams_before = copy.deepcopy(brain.progress["streams"])
    path = str(tmp_path / f"blocked-{boundary}-{answer}-{retirement}.sqlite")
    state = StateStore(path)
    provider = _LateAnswerProvider(brain, error)
    abandoned = await _abandon_first_creation(state, provider)
    assert _restriction(state, answer) is None  # the abandoned worker has not answered yet

    blocked: list[str] = []

    async def answer_while_publication_is_blocked(payload):
        fresh = [r for r in _records_in(payload)
                 if r["state"] == boundary and r["attempt_id"] != abandoned.attempt_id]
        if fresh and not provider.release.is_set():
            provider.release.set()
            await _until(lambda: _restriction(state, answer) is not None)
            blocked.append(fresh[0]["attempt_id"])

    _hook_checkpoints(monkeypatch, answer_while_publication_is_blocked)
    if retirement == "publication-fails":
        def refuse_the_retirement(payload):
            if any(r["state"] == RETIRED and str(r.get("detail") or "").startswith("not dispatched")
                   for r in _records_in(payload)):
                return BrainError(503, "server_error", "brain unavailable")
            return None
        brain.checkpoint_faults.append(refuse_the_retirement)

    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)

    (attempt_id,) = blocked  # the restriction landed while this attempt's publication was blocked
    watch_calls = [call for call in provider.calls if call[0] == "watch"]
    assert watch_calls.count(("watch", "my-drive")) == 1  # only the cancelled sweep's own request
    if answer == "minimum" and retirement == "published":
        # A drive-specific minimum blocks that drive only: the independent drive is still created.
        assert watch_calls == [("watch", "my-drive"), ("watch", "shared-x")]
    else:
        assert watch_calls == [("watch", "my-drive")]
    if answer == "quota":
        assert provider.calls == [("watch", "my-drive")]  # the account hold stops every watch call
        assert _published_hold(brain) is None  # a late hold waits for a fresh acquisition

    records = brain.records()
    attempt = records[attempt_id]
    if retirement == "published":
        assert attempt.state == RETIRED and attempt.detail.startswith("not dispatched")
        assert _local_watch_state(state, attempt_id) == RETIRED
    else:
        assert attempt.state == boundary  # the last acknowledged record
        assert _local_watch_state(state, attempt_id) == boundary  # no unacknowledged retirement
    assert attempt.resource_id is None
    assert records[abandoned.attempt_id].state == UNCERTAIN  # recovered, never activated
    assert records["current"].state == ACTIVE  # the predecessor is untouched
    assert brain.progress["streams"] == streams_before  # no cursor moved
    state.close()

    # Reopened, before the deadline: the restriction persists, my-drive is still not requested, and
    # a failed retirement is recovered from the acknowledged record (an intent never sent retires; a
    # marker whose outcome was not published is uncertain — the existing recovery rules).
    state = StateStore(path)
    assert _restriction(state, answer) is not None
    provider.calls.clear()
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert ("watch", "my-drive") not in provider.calls
    records = brain.records()
    if retirement == "publication-fails":
        assert records[attempt_id].state == (RETIRED if boundary == PREPARED else UNCERTAIN)
    assert records[attempt_id].resource_id is None
    assert records["current"].state == ACTIVE
    assert brain.progress["streams"] == streams_before
    state.close()

    if retirement == "publication-fails" and boundary == DISPATCHED:
        return  # two unresolved attempts on my-drive: polling covers it until they resolve (cap)
    # After the deadline my-drive is eligible again.
    after = datetime.fromisoformat(str(error.deferral.not_before)) + timedelta(seconds=1)
    monkeypatch.setattr("aios_ingest.gdrive_sync._now", lambda: after.isoformat())
    state = StateStore(path)
    provider.calls.clear()
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert ("watch", "my-drive") in provider.calls
    state.close()


@pytest.mark.asyncio
async def test_a_creation_queued_behind_the_abandoned_worker_is_refused_at_the_dispatch_boundary(
    tmp_path, monkeypatch,
):
    """Both pool workers are busy — one is the cancelled sweep's abandoned creation — so the fresh
    sweep's admitted, durably marked creation waits in the queue. The abandoned worker then answers
    with the account's quota and its thread takes the queued request at once; the final check, asked on
    the loop that owns the StateStore immediately before the request, sees the hold. Nothing is sent
    and the attempt retires as not dispatched."""
    brain = _quota_brain(due=True).install(monkeypatch)
    streams_before = copy.deepcopy(brain.progress["streams"])
    state = StateStore(str(tmp_path / "queued.sqlite"))
    provider = _LateAnswerProvider(brain, _late_answer("quota"))
    abandoned = await _abandon_first_creation(state, provider)
    release_busy = threading.Event()
    busy = watch_renewal._POOL.submit(release_busy.wait, 10)
    try:
        await _until(busy.running)  # both pool workers are now occupied
        second = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
        await _until(lambda: watch_renewal._POOL._work_queue.qsize() > 0)  # the creation is queued
        assert _hold(state) is None
        provider.release.set()  # the abandoned worker answers; its thread then takes the queued item
        await second
    finally:
        release_busy.set()
        busy.result(10)

    assert provider.calls == [("watch", "my-drive")]  # the queued request was never sent
    assert _hold(state) is not None
    records = brain.records()
    (attempt,) = [r for r in records.values()
                  if r.predecessor == "current" and r.attempt_id != abandoned.attempt_id]
    assert attempt.state == RETIRED
    assert attempt.detail == "not dispatched: the account's provider quota hold stands"
    assert records[abandoned.attempt_id].state == UNCERTAIN
    assert records["current"].state == ACTIVE
    assert brain.progress["streams"] == streams_before
    assert _published_hold(brain) is None
    state.close()


class _BlockingGate:
    """The brain's live authority gate, whose FIRST check blocks in the worker until released — and
    then, if ``failure`` is set, refuses with it (the live authority check failing)."""

    def __init__(self, failure: Exception | None = None):
        self.entered, self.release = threading.Event(), threading.Event()
        self.checks = 0
        self.failure = failure

    def __call__(self):
        self.checks += 1
        if self.checks == 1:
            self.entered.set()
            assert self.release.wait(10), "the test never released the authority check"
            if self.failure is not None:
                raise self.failure

    def close(self):
        pass


_REFUSALS = {
    "quota": "not dispatched: the account's provider quota hold stands",
    "minimum": "not dispatched: a provider minimum for creating a channel on this drive stands",
}


@pytest.mark.parametrize("answer", ["quota", "minimum"])
@pytest.mark.asyncio
async def test_a_restriction_journaled_while_the_production_managers_authority_check_blocks_prevents_the_request(
    tmp_path, monkeypatch, answer,
):
    """The PRODUCTION watch manager makes the live authority check immediately before
    ``request.execute``, and that check can block. A fresh sweep's my-drive creation passes every
    earlier admission and blocks inside it; meanwhile the cancelled sweep's abandoned worker answers and
    its restriction — the account's quota or my-drive's creation minimum — is journaled on the loop.
    When the check returns, admission is decided once more: ``request.execute`` is never called and the
    attempt retires as provably not dispatched. A drive minimum leaves the independent drive's creation
    alone; the account hold stops every further watch call."""
    brain = _quota_brain(due=True).install(monkeypatch)
    streams_before = copy.deepcopy(brain.progress["streams"])
    state = StateStore(str(tmp_path / f"gate-{answer}.sqlite"))
    late = _LateAnswerProvider(brain, _late_answer(answer))
    abandoned = await _abandon_first_creation(state, late)

    # Sweep 2 runs through the production manager over a scripted transport: every `request.execute`
    # is recorded in `drive.calls`. Its authority check blocks the first time.
    drive = _fake_drive(monkeypatch)
    gate = _BlockingGate()
    monkeypatch.setattr(
        watch_renewal.brain_client.BrainClient, "gdrive_provider_gate", lambda self, execution: gate,
    )
    second = asyncio.create_task(watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS))
    await asyncio.to_thread(gate.entered.wait, 10)
    assert _restriction(state, answer) is None  # every admission before the authority check passed
    (attempt,) = [r for r in brain.records().values()
                  if r.predecessor == "current" and r.attempt_id != abandoned.attempt_id]
    assert attempt.state == DISPATCHED  # durably marked, inside the manager, not yet sent

    late.release.set()  # the abandoned worker answers; its restriction is journaled on this loop
    await _until(lambda: _restriction(state, answer) is not None)
    gate.release.set()
    await second

    watch_requests = [call for call in drive.calls if call[0] == "watch"]
    assert ("watch", "my-drive") not in watch_requests  # `request.execute` was never called for it
    if answer == "quota":
        assert drive.calls == []  # the account hold stops every watch call, stops included
        assert _published_hold(brain) is None  # a late hold waits for a fresh acquisition
    else:
        assert watch_requests == [("watch", "shared-x")]  # the independent drive is still created
    records = brain.records()
    retired = records[attempt.attempt_id]
    assert retired.state == RETIRED and retired.detail == _REFUSALS[answer]
    assert retired.resource_id is None
    assert _local_watch_state(state, attempt.attempt_id) == RETIRED
    assert records[abandoned.attempt_id].state == UNCERTAIN  # recovered, never activated
    assert records["current"].state == ACTIVE  # the predecessor is untouched
    assert brain.progress["streams"] == streams_before  # no cursor moved
    assert _restriction(state, answer) is not None  # the restriction persists
    assert brain.events[-1] == "release"
    state.close()


# ------------------------------------------------------------------------------------------------ #
# The same window for a cleanup STOP: a restriction that lands while its authority check blocks
# ------------------------------------------------------------------------------------------------ #

class _LateStopProvider(_LateAnswerProvider):
    """Google, scripted: the FIRST stop blocks in its worker until released, then raises ``error``."""

    def __init__(self, brain, error):
        super().__init__(brain, error)
        self.kind = "stop"


def _late_stop_answer(answer: str):
    if answer == "quota":
        return WatchQuotaLimited(_deferral(_at(int(LONG))))
    return WatchProviderMinimum(_minimum(int(LONG)))


def _stop_restriction(state, answer: str):
    """The restriction the late stop answer journals: the account's hold, or old0's stop minimum."""
    if answer == "quota":
        return _hold(state)
    return state.document_restrictions(INTEGRATION, GEN, ACCOUNT).get("watch-stop:res-old0")


async def _abandon_first_stop(state, provider):
    """Sweep 1: its stop of ``old0`` blocks in a worker and the sweep is cancelled around it — the worker
    keeps running, abandoned, with the production late-result handler attached."""
    first = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(provider.entered.wait, 10)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    records = provider.brain.records()
    assert records["old0"].state == CLEANUP_PENDING and records["old0"].stop_attempts == 0


@pytest.mark.parametrize("answer, authority_fails", [
    pytest.param("quota", False, id="account-quota"),
    pytest.param("minimum", False, id="stop-minimum"),
    pytest.param("minimum", True, id="authority-failure-wins"),
])
@pytest.mark.asyncio
async def test_a_restriction_journaled_while_a_stops_authority_check_blocks_prevents_the_stop(
    tmp_path, monkeypatch, answer, authority_fails,
):
    """The PRODUCTION watch manager makes the live authority check immediately before a stop's
    ``request.execute``, and that check can block. A fresh sweep's stop of ``old0`` passes initial
    admission and blocks inside it; meanwhile the cancelled sweep's abandoned stop worker answers and
    its restriction — the account's quota or old0's stop minimum — is journaled on the loop. When the
    check returns, admission is decided once more: the stop is never executed, and it is provably
    unsent — old0 stays cleanup_pending with its resource and stop attempts, and nothing is published
    for it. The account hold ends the account's cleanup; old0's minimum defers old0 alone and old1 is
    still stopped. A failing authority check keeps its precedence: the run ends on it."""
    brain = _quota_brain(due=False).install(monkeypatch)  # no creation is due; old0 and old1 to stop
    streams_before = copy.deepcopy(brain.progress["streams"])
    state = StateStore(str(tmp_path / f"stop-gate-{answer}-{authority_fails}.sqlite"))
    late = _LateStopProvider(brain, _late_stop_answer(answer))
    await _abandon_first_stop(state, late)

    # Sweep 2 stops through the production manager over a scripted transport: every
    # `request.execute` is recorded in `drive.calls`. Its first authority check blocks.
    drive = _fake_drive(monkeypatch)
    gate = _BlockingGate(BrainError(409, "connection_unavailable", "paused") if authority_fails else None)
    monkeypatch.setattr(
        watch_renewal.brain_client.BrainClient, "gdrive_provider_gate", lambda self, execution: gate,
    )
    second = asyncio.create_task(watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS))
    await asyncio.to_thread(gate.entered.wait, 10)
    assert _stop_restriction(state, answer) is None  # old0's stop passed initial admission

    late.release.set()  # the abandoned stop answers; its restriction is journaled on this loop
    await _until(lambda: _stop_restriction(state, answer) is not None)
    gate.release.set()
    await second

    assert ("stop", "old0") not in drive.calls  # `request.execute` was never called for old0
    if answer == "quota" or authority_fails:
        # The account hold ends the account's cleanup; a failed authority check ends the run.
        assert drive.calls == []
    else:
        assert drive.calls == [("stop", "old1")]  # the independent channel is still stopped
    records = brain.records()
    old0 = records["old0"]
    assert old0.state == CLEANUP_PENDING  # never retired, never counted as a failed stop
    assert old0.resource_id == "res-old0" and old0.stop_attempts == 0
    if answer == "minimum" and not authority_fails:
        assert records["old1"].state == RETIRED and records["old1"].detail == "stopped"
    else:
        assert records["old1"].state == CLEANUP_PENDING and records["old1"].stop_attempts == 0
    assert records["current"].state == ACTIVE and records["current-x"].state == ACTIVE
    assert brain.progress["streams"] == streams_before  # no cursor moved
    assert _stop_restriction(state, answer) is not None  # the restriction persists
    if answer == "quota":
        assert _published_hold(brain) is None  # a late hold stays local until a fresh acquisition
    assert brain.events[-1] == "release"
    state.close()
