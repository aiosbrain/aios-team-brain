"""Non-quota watch Retry-After minima are durable per operation (AIO-1167 final review A4).

Spec (accepted-spec AC-04; Astra adjudication A4). Through the REAL watch manager classifier and the real
renewal sweep, a watch creation or stop answered with a non-quota 503 carrying a valid Retry-After:

  * creation stays UNCERTAIN (never active, never resent blindly) and restricts creation on that
    account/drive (`watch-create:<drive>`) — not the random attempt; a stop keeps its record
    cleanup_pending, spends no stop attempt, and restricts stopping THAT channel resource
    (`watch-stop:<resource>`) under the verified account of the current transport, even for an older
    account's record;
  * the minimum is journaled before outcome publication and published through the shared restriction
    owner; a second sweep, a reopened store and a fresh store restored from acknowledged progress make
    no call to the restricted operation before it, while other drives/channels proceed; expiry resumes;
  * a 503 naming no (or a malformed) minimum keeps its existing outcome and records nothing durable;
    429/quota-403 stay account-wide (covered by ``test_watch_quota_hold``).
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import json
import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from aios_ingest import watch_renewal
from aios_ingest.brain_client import BrainError
from aios_ingest.state import StateStore, StreamKey
from aios_ingest.watch_lifecycle import (
    ACTIVE, CLEANUP_PENDING, UNCERTAIN, WatchProviderMinimum, WatchQuotaLimited, from_section, to_section,
)
from test_watch_late_quota import _at, _deferral, _hook_checkpoints, _records_in, _until
from test_watch_lifecycle import ACCOUNT, INTEGRATION, SETTINGS, _conn, _controlled_deadline, _Provider
from test_watch_quota_hold import (
    GEN, LONG, _fake_drive, _GoogleError, _hold, _manager, _published_hold, _quota_brain,
)


def _restriction(state, resource, account=ACCOUNT):
    return state.document_restrictions(INTEGRATION, GEN, account).get(resource)


def _published(brain, resource):
    items = (brain.progress.get("document_restrictions") or {}).get("items") or []
    return [item for item in items if item.get("id") == resource]


@pytest.mark.asyncio
async def test_a_creation_503_with_retry_after_stays_uncertain_and_blocks_that_drive_until_expiry(
    tmp_path, monkeypatch,
):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(503, LONG)]
    brain = _quota_brain(due=True).install(monkeypatch)
    streams_before = copy.deepcopy(brain.progress["streams"])
    path = str(tmp_path / "create.sqlite")
    state = StateStore(path)

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    assert ("watch", "my-drive") in fake.calls and ("watch", "shared-x") in fake.calls  # other drive proceeds
    records = brain.records()
    (attempt,) = [r for r in records.values() if r.predecessor == "current"]
    assert attempt.state == UNCERTAIN  # never active, never refused
    assert records["current"].state == ACTIVE  # the valid predecessor stays
    assert _restriction(state, "watch-create:my-drive") is not None  # account/drive, not the attempt
    assert _restriction(state, f"watch-create:{attempt.attempt_id}") is None
    assert _published(brain, "watch-create:my-drive")
    assert brain.progress["streams"] == streams_before  # no cursor moved
    state.close()

    # Second sweep (reopened) and a fresh store restored from acknowledged progress: no early call.
    for name in ("create.sqlite", "create-fresh.sqlite"):
        fake.calls.clear()
        again = StateStore(str(tmp_path / name))
        await watch_renewal.renew_watches(again, _manager(), [_conn()], SETTINGS)
        assert ("watch", "my-drive") not in fake.calls
        assert _restriction(again, "watch-create:my-drive") is not None
        again.close()

    # After the minimum the drive is eligible again.
    deadline = datetime.now(timezone.utc) + timedelta(seconds=int(LONG) + 60)
    monkeypatch.setattr("aios_ingest.gdrive_sync._now", lambda: deadline.isoformat())
    fake.calls.clear()
    state = StateStore(path)
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
    assert ("watch", "my-drive") in fake.calls
    state.close()


@pytest.mark.asyncio
async def test_a_stop_503_with_retry_after_waits_without_spending_an_attempt_under_the_transport_account(
    tmp_path, monkeypatch,
):
    fake = _fake_drive(monkeypatch)
    fake.stop_answers = [_GoogleError(503, LONG)]
    brain = _quota_brain(due=False)
    records = from_section(brain.progress)
    # old0 was created under an OLDER account: the restriction still belongs to the current transport.
    records["old0"] = dataclasses.replace(
        records["old0"], account_id="previous-account",
        namespace=StreamKey("demo", INTEGRATION, "previous-account", "my-drive").namespace(GEN),
    )
    brain.progress["watches"] = to_section(records)
    brain.install(monkeypatch)
    path = str(tmp_path / "stop.sqlite")
    state = StateStore(path)

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    assert fake.calls[:2] == [("stop", "old0"), ("stop", "old1")]  # the other channel is still stopped
    records = brain.records()
    assert records["old0"].state == CLEANUP_PENDING and records["old0"].stop_attempts == 0  # waiting ≠ failing
    assert _restriction(state, "watch-stop:res-old0") is not None
    assert _restriction(state, "watch-stop:res-old0", account="previous-account") is None
    assert _published(brain, "watch-stop:res-old0")
    state.close()

    fake.calls.clear()
    state = StateStore(path)
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
    assert ("stop", "old0") not in fake.calls  # not before the minimum
    assert brain.records()["old0"].stop_attempts == 0
    state.close()


@pytest.mark.parametrize("header", [None, "soon"], ids=["missing", "malformed"])
@pytest.mark.asyncio
async def test_a_503_naming_no_minimum_keeps_its_outcome_and_records_nothing_durable(tmp_path, monkeypatch, header):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(503, header)]
    fake.stop_answers = [_GoogleError(503, header)]
    brain = _quota_brain(due=True).install(monkeypatch)
    state = StateStore(str(tmp_path / f"no-minimum-{header}.sqlite"))

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    (attempt,) = [r for r in brain.records().values() if r.predecessor == "current"]
    assert attempt.state == UNCERTAIN
    assert _restriction(state, "watch-create:my-drive") is None
    assert _restriction(state, "watch-stop:res-old0") is None
    assert brain.records()["old0"].stop_attempts == 1  # an ordinary failed stop, as before
    state.close()


# ------------------------------------------------------------------------------------------------ #
# Publication separation, late operation workers and failed/lost/stale publication
# ------------------------------------------------------------------------------------------------ #

def _minimum(seconds: int = 86_400) -> SimpleNamespace:
    """The shared parser's non-quota provider minimum as a watch call carries it."""
    return SimpleNamespace(
        not_before=(datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(),
        category="provider_unavailable", provider_deadline=True, diagnostic=None,
    )


class _ScriptedProvider(_Provider):
    """Google, scripted per drive: ``answers[drive]`` is a callable run in the dispatch worker."""

    def __init__(self, brain, answers):
        super().__init__(brain)
        self.answers = answers
        self.calls: list[str] = []

    def dispatch(self, record, *, page_token, verification_token, access_token=None,
                 provider_gate=None, deadline=None):
        self.calls.append(record.drive_id)
        answer = self.answers.get(record.drive_id)
        if answer is not None:
            answer()
        return super().dispatch(record, page_token=page_token, verification_token=verification_token,
                                access_token=access_token, provider_gate=provider_gate, deadline=deadline)


def _raise(exc):
    def answer():
        raise exc
    return answer


def _restriction_items(payload):
    return [item.get("id") for item in (payload.get("document_restrictions") or {}).get("items") or []]


@pytest.mark.asyncio
async def test_operation_minima_publish_in_the_sweep_while_a_late_account_hold_waits_for_the_next_acquisition(
    tmp_path, monkeypatch,
):
    deadline_passed = _controlled_deadline(monkeypatch)
    brain = _quota_brain(due=True).install(monkeypatch)
    release, entered = threading.Event(), threading.Event()

    def late_quota():
        entered.set()
        assert release.wait(10)
        raise WatchQuotaLimited(_deferral(_at(int(LONG))))

    provider = _ScriptedProvider(brain, {
        "my-drive": _raise(WatchProviderMinimum(_minimum())),  # a timely operation minimum
        "shared-x": late_quota,  # abandoned, then answers the ACCOUNT's quota
    })
    state = StateStore(str(tmp_path / "separation.sqlite"))

    async def answer_late(payload):
        shared = [r for r in _records_in(payload) if r["drive_id"] == "shared-x" and r["state"] == UNCERTAIN]
        if shared and not release.is_set():
            release.set()
            await _until(lambda: _hold(state) is not None)

    _hook_checkpoints(monkeypatch, answer_late)
    sweep = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(entered.wait, 10)
    deadline_passed.set()
    await sweep

    assert _hold(state) is not None  # journaled locally, blocking at once
    assert _published_hold(brain) is None  # ... but NOT published in this sweep
    assert _published(brain, "watch-create:my-drive")  # the operation minimum IS published
    assert provider.stopped == []  # the hold stopped the rest of the sweep
    state.close()

    # The next fresh acquisition publishes the hold.
    state = StateStore(str(tmp_path / "separation.sqlite"))
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert _published_hold(brain) is not None and _published_hold(brain)[0] == _hold(state)[0]
    state.close()


@pytest.mark.asyncio
async def test_a_late_operation_minimum_from_an_abandoned_create_worker_is_journaled_and_gates(
    tmp_path, monkeypatch,
):
    deadline_passed = _controlled_deadline(monkeypatch)
    brain = _quota_brain(due=True).install(monkeypatch)
    release, entered = threading.Event(), threading.Event()

    def late_minimum():
        entered.set()
        assert release.wait(10)
        raise WatchProviderMinimum(_minimum())

    provider = _ScriptedProvider(brain, {"my-drive": late_minimum})
    path = str(tmp_path / "late-minimum.sqlite")
    state = StateStore(path)

    async def answer_late(payload):
        mine = [r for r in _records_in(payload) if r["drive_id"] == "my-drive" and r["state"] == UNCERTAIN]
        if mine and not release.is_set():
            release.set()
            await _until(lambda: _restriction(state, "watch-create:my-drive") is not None)

    _hook_checkpoints(monkeypatch, answer_late)
    sweep = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(entered.wait, 10)
    deadline_passed.set()
    await sweep

    (attempt,) = [r for r in brain.records().values() if r.predecessor == "current"]
    assert attempt.state == UNCERTAIN  # the late answer activated nothing
    assert _restriction(state, "watch-create:my-drive") is not None
    assert _hold(state) is None  # an operation minimum is never an account hold
    state.close()

    provider.calls.clear()
    state = StateStore(path)
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert "my-drive" not in provider.calls
    state.close()


@pytest.mark.parametrize("failure", ["delivery-failure", "acknowledgment-lost"])
@pytest.mark.asyncio
async def test_a_failed_or_lost_operation_minimum_publication_keeps_the_journal_and_republishes(
    tmp_path, monkeypatch, failure,
):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(503, LONG)]
    brain = _quota_brain(due=True)

    def fault(payload):
        if "watch-create:my-drive" not in _restriction_items(payload):
            return None
        if failure == "acknowledgment-lost":
            brain.progress = json.loads(json.dumps(payload))  # stored; the answer never arrives
            brain.revision += 1
        return BrainError(503, "server_error", "publication not acknowledged")

    brain.checkpoint_faults.append(fault)
    brain.install(monkeypatch)
    path = str(tmp_path / f"publish-{failure}.sqlite")
    state = StateStore(path)
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    assert _restriction(state, "watch-create:my-drive") is not None  # the journal is kept
    if failure == "delivery-failure":
        assert not _published(brain, "watch-create:my-drive")
    state.close()

    fake.calls.clear()
    state = StateStore(path)
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
    assert ("watch", "my-drive") not in fake.calls
    assert _published(brain, "watch-create:my-drive")  # published by the next sweep (or already stored)
    state.close()


@pytest.mark.parametrize("failure", ["delivery-failure", "acknowledgment-lost", "stale-fence"])
@pytest.mark.asyncio
async def test_a_create_minimum_survives_a_failed_lost_or_stale_outcome_publication(
    tmp_path, monkeypatch, failure,
):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(503, LONG)]
    brain = _quota_brain(due=True)

    def fault(payload):
        uncertain = [r for r in _records_in(payload) if r["state"] == UNCERTAIN and r["drive_id"] == "my-drive"]
        if not uncertain:
            return None
        if failure == "acknowledgment-lost":
            brain.progress = json.loads(json.dumps(payload))
            brain.revision += 1
            return BrainError(503, "server_error", "lost")
        if failure == "stale-fence":
            return BrainError(409, "stale_execution", "replaced")
        return BrainError(503, "server_error", "unavailable")

    brain.checkpoint_faults.append(fault)
    brain.install(monkeypatch)
    path = str(tmp_path / f"outcome-{failure}.sqlite")
    state = StateStore(path)
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    # Journaled BEFORE the fallible outcome publication: kept whatever happened to it.
    assert _restriction(state, "watch-create:my-drive") is not None
    assert all(r.state != ACTIVE for r in brain.records().values() if r.predecessor == "current")
    assert brain.events[-1] == "release"
    state.close()

    fake.calls.clear()
    state = StateStore(path)
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
    assert ("watch", "my-drive") not in fake.calls  # no early repeat of the non-idempotent create
    state.close()
