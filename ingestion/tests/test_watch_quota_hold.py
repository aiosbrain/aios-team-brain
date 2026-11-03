"""Watch creation and stop quota responses establish the account hold (AIO-1167 R51 final 3).

Spec (accepted-spec AC-04; Astra 20:01 UTC adjudication, finding 3). A watch call answered 429, or 403
naming a quota reason, is the ACCOUNT's quota — classified and represented exactly as a polling
provider call (``sources.gdrive.quota_deferral``): the parsed Retry-After deadline unshortened, the
bounded fallback for a missing/malformed header, the last-instant sentinel for an unrepresentable one.
Through the REAL watch manager translation and the real renewal sweep:

  * renewal journals the hold locally (monotonic, this verified account), publishes it through the
    shared restriction owner under the current fence/revision, and makes NO further watch creation
    or stop call for the account in that sweep — whether publication succeeds or fails;
  * a definitive quota-rejected creation retires that attempt only; the predecessor channel and every
    cursor are unchanged; a quota-rejected stop stays ``cleanup_pending`` with no attempt spent;
  * a reopened SQLite file, a fresh one restored from acknowledged progress, and polling at a later
    generation of the same account all honour the hold; renewal resumes after the deadline;
  * a failed acknowledgment keeps the local hold and the next sweep publishes it; under the
    uncertainty latch nothing is sent;
  * another credential's hold is neither adopted nor disturbed; a lapsed shorter hold is replaced and
    a later shorter one never shortens it;
  * an ordinary permission 403, a 404, a timeout-like 5xx are never account holds.
"""

from __future__ import annotations

import asyncio
import copy
import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from aios_ingest import watch_renewal
from aios_ingest.brain_client import BrainError
from aios_ingest.connector_state import (
    RESTRICTION_KEYS, add_hold, apply_restriction_sections, parse_restriction_evidence, restriction_sections,
)
from aios_ingest.gdrive_sync import _restriction_standing, _standing_account_hold, run_gdrive_stream
from aios_ingest.sources.gdrive import LATEST_INSTANT
from aios_ingest.sources.gdrive_watch import ConfiguredGoogleDriveWatchManager, GoogleDriveWatchManager
from aios_ingest.state import StateStore, StreamKey
from aios_ingest.watch_lifecycle import (
    ACTIVE, CLEANUP_PENDING, DISPATCHED, RETIRED, UNCERTAIN, WatchQuotaLimited, WatchRefused, to_section,
)
import test_account_hold_before_streams as polling
from test_watch_lifecycle import ACCOUNT, INTEGRATION, SETTINGS, _Brain, _conn, _ms, _record

GEN = 3  # the generation the lifecycle brain double acquires
LONG = "99999999"


class _GoogleError(Exception):
    """A Google API error as the client raises it: status and headers on ``resp``, reasons parsed."""

    def __init__(self, status, retry_after=None, reason=None):
        super().__init__(f"HTTP {status}")
        self.resp = SimpleNamespace(
            status=status, headers={"Retry-After": retry_after} if retry_after is not None else {},
        )
        self.error_details = [{"reason": reason}] if reason else []


class _FakeDrive:
    """Google Drive's watch endpoints, scripted: each call takes the next scripted answer."""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []
        self.watch_answers: list = []
        self.stop_answers: list = []

    def changes(self):
        drive = self

        class Changes:
            def watch(self, **kwargs):
                return _Request(drive, "watch", kwargs.get("driveId", "my-drive"), kwargs["body"])
        return Changes()

    def channels(self):
        drive = self

        class Channels:
            def stop(self, body):
                return _Request(drive, "stop", body["id"], body)
        return Channels()


class _Request:
    def __init__(self, drive, kind, target, body):
        self.drive, self.kind, self.target, self.body = drive, kind, target, body

    def execute(self, num_retries=0):
        self.drive.calls.append((self.kind, self.target))
        answers = self.drive.watch_answers if self.kind == "watch" else self.drive.stop_answers
        answer = answers.pop(0) if answers else None
        if callable(answer):  # runs inside the request — already sent — e.g. blocks, then answers
            answer = answer()
        if isinstance(answer, Exception):
            raise answer
        if self.kind == "watch":
            return {
                "id": self.body["id"], "resourceId": f"res-{self.body['id']}",
                "expiration": _ms(timedelta(days=6)),
            }
        return {}


def _fake_drive(monkeypatch) -> _FakeDrive:
    fake = _FakeDrive()
    monkeypatch.setattr(GoogleDriveWatchManager, "_service", lambda self, deadline=None: fake)
    return fake


def _ns(drive_id):
    return StreamKey("demo", INTEGRATION, ACCOUNT, drive_id).namespace(GEN)


def _quota_brain(*, due: bool, cleanups: int = 2) -> _Brain:
    """Two streams; ``due``: my-drive's channel is due (a successor is created) and shared-x has
    none; otherwise both have channels that are not due. Plus ``cleanups`` channels to stop."""
    brain = _Brain()
    brain.progress["streams"] = {
        "my-drive": {"drive_id": "my-drive", "page_token": "cursor-my"},
        "shared-x": {"drive_id": "shared-x", "page_token": "cursor-x"},
    }
    now = datetime.now(timezone.utc)
    records = {
        "current": _record(
            ACTIVE, attempt_id="current", resource_id="res-current",
            expires_at=(now + (timedelta(minutes=5) if due else timedelta(days=6))).isoformat(),
        ),
    }
    if not due:
        records["current-x"] = _record(
            ACTIVE, attempt_id="current-x", resource_id="res-current-x", drive_id="shared-x",
            namespace=_ns("shared-x"), expires_at=(now + timedelta(days=6)).isoformat(),
        )
    for i in range(cleanups):
        records[f"old{i}"] = _record(
            CLEANUP_PENDING, attempt_id=f"old{i}", resource_id=f"res-old{i}",
            expires_at=(now + timedelta(days=5)).isoformat(),
        )
    brain.progress["watches"] = to_section(records)
    return brain


def _manager():
    return ConfiguredGoogleDriveWatchManager([_conn()])


def _hold(state, credential=ACCOUNT):
    return state.connection_hold(INTEGRATION, GEN, credential)


def _published_hold(brain, credential=ACCOUNT):
    entry = parse_restriction_evidence(brain.progress).get(credential) or {}
    return entry.get("hold")


def _near(instant: str, expected: datetime, tolerance: float = 120) -> bool:
    return abs((datetime.fromisoformat(instant) - expected).total_seconds()) < tolerance


# ------------------------------------------------------------------------------------------------ #
# The watch manager's error translation (real dispatch / stop, scripted transport)
# ------------------------------------------------------------------------------------------------ #

def _direct_manager(monkeypatch):
    fake = _fake_drive(monkeypatch)
    return GoogleDriveWatchManager(webhook_url="https://example.test/watch", access_token="t"), fake


@pytest.mark.parametrize("answer", [
    pytest.param(lambda: _GoogleError(429, LONG), id="429"),
    pytest.param(lambda: _GoogleError(403, LONG, reason="rateLimitExceeded"), id="quota-403"),
])
def test_a_quota_answer_to_creation_or_stop_is_translated_with_its_deadline(monkeypatch, answer):
    manager, fake = _direct_manager(monkeypatch)
    started = datetime.now(timezone.utc)
    fake.watch_answers = [answer()]
    with pytest.raises(WatchQuotaLimited) as created:
        manager.dispatch(_record(DISPATCHED), page_token="cursor", verification_token="token")
    fake.stop_answers = [answer()]
    with pytest.raises(WatchQuotaLimited) as stopped:
        manager.stop("old", "res-old")
    for raised in (created.value, stopped.value):
        assert raised.deferral.category == "rate_limited"
        assert raised.deferral.provider_deadline is True
        assert _near(raised.deferral.not_before, started + timedelta(seconds=int(LONG)))  # unshortened


@pytest.mark.parametrize("header, check", [
    ("soon", "fallback-malformed"), (None, "fallback"), ("9" * 30, "latest"),
])
def test_a_quota_answer_without_a_valid_retry_after_uses_the_established_representation(monkeypatch, header, check):
    manager, fake = _direct_manager(monkeypatch)
    started = datetime.now(timezone.utc)
    fake.watch_answers = [_GoogleError(429, header)]
    with pytest.raises(WatchQuotaLimited) as raised:
        manager.dispatch(_record(DISPATCHED), page_token="cursor", verification_token="token")
    deferral = raised.value.deferral
    if check == "latest":
        assert deferral.not_before == LATEST_INSTANT.isoformat()
        assert deferral.diagnostic == "retry_after_unrepresentable"
    else:
        assert datetime.fromisoformat(deferral.not_before) <= started + timedelta(seconds=4.5)
        assert deferral.provider_deadline is False
        assert deferral.diagnostic == ("retry_after_malformed" if check == "fallback-malformed" else None)


def test_non_quota_answers_keep_their_existing_watch_outcomes(monkeypatch):
    manager, fake = _direct_manager(monkeypatch)
    fake.watch_answers = [_GoogleError(403)]  # a permission refusal names no quota reason
    with pytest.raises(WatchRefused):
        manager.dispatch(_record(DISPATCHED), page_token="cursor", verification_token="token")
    fake.watch_answers = [_GoogleError(500)]  # outcome unknown: raised as is
    with pytest.raises(_GoogleError):
        manager.dispatch(_record(DISPATCHED), page_token="cursor", verification_token="token")
    fake.stop_answers = [_GoogleError(404)]  # already gone
    assert manager.stop("old", "res-old") is None
    fake.stop_answers = [_GoogleError(403)]
    with pytest.raises(_GoogleError):
        manager.stop("old", "res-old")


# ------------------------------------------------------------------------------------------------ #
# Renewal learns the hold, stops, publishes — and every surface honours it
# ------------------------------------------------------------------------------------------------ #

@pytest.mark.asyncio
async def test_a_creation_quota_answer_holds_the_account_and_stops_every_further_watch_call(
    tmp_path, monkeypatch,
):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(429, LONG)]
    brain = _quota_brain(due=True).install(monkeypatch)
    streams_before = copy.deepcopy(brain.progress["streams"])
    path = str(tmp_path / "creation.sqlite")
    state = StateStore(path)
    started = datetime.now(timezone.utc)

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    # One creation — then no second creation and no stop.
    assert fake.calls == [("watch", "my-drive")]
    held = _hold(state)
    assert held is not None and _near(held[0], started + timedelta(seconds=int(LONG)))
    assert _published_hold(brain) is not None and _published_hold(brain)[0] == held[0]  # published
    records = brain.records()
    assert records["current"].state == ACTIVE  # the valid predecessor is untouched
    retired = [r for r in records.values() if r.state == RETIRED and r.predecessor == "current"]
    assert len(retired) == 1  # the definitive quota-rejected attempt retired, and nothing else
    assert all(records[f"old{i}"].state == CLEANUP_PENDING for i in range(2))
    assert all(records[f"old{i}"].stop_attempts == 0 for i in range(2))
    assert brain.progress["streams"] == streams_before  # no cursor moved
    assert brain.events[-1] == "release"
    state.close()

    # A reopened SQLite file and a fresh one restored from acknowledged progress: no watch call.
    for name in ("creation.sqlite", "fresh.sqlite"):
        fake.calls.clear()
        again = StateStore(str(tmp_path / name))
        await watch_renewal.renew_watches(again, _manager(), [_conn()], SETTINGS)
        assert fake.calls == []
        assert _hold(again) == held
        again.close()

    # After the deadline renewal resumes: the due creations and the pending stops are made.
    monkeypatch.setattr(
        "aios_ingest.gdrive_sync._now",
        lambda: (datetime.fromisoformat(held[0]) + timedelta(seconds=1)).isoformat(),
    )
    fake.calls.clear()
    state = StateStore(path)
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
    assert ("watch", "my-drive") in fake.calls and ("watch", "shared-x") in fake.calls
    assert ("stop", "old0") in fake.calls
    state.close()


@pytest.mark.asyncio
async def test_a_stop_quota_answer_keeps_the_channel_cleanup_pending_and_holds_the_account(tmp_path, monkeypatch):
    fake = _fake_drive(monkeypatch)
    fake.stop_answers = [_GoogleError(429, LONG)]
    brain = _quota_brain(due=False).install(monkeypatch)
    state = StateStore(str(tmp_path / "stop.sqlite"))

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    assert fake.calls == [("stop", "old0")]  # the second stop is never attempted
    records = brain.records()
    assert records["old0"].state == CLEANUP_PENDING and records["old0"].stop_attempts == 0
    assert records["old1"].state == CLEANUP_PENDING and records["old1"].stop_attempts == 0
    assert records["current"].state == ACTIVE and records["current-x"].state == ACTIVE
    assert _hold(state) is not None and _published_hold(brain) is not None
    state.close()


@pytest.mark.asyncio
async def test_polling_at_a_later_generation_of_the_same_account_honours_the_watch_learned_hold(
    tmp_path, monkeypatch,
):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(429, LONG)]
    brain = _quota_brain(due=True).install(monkeypatch)
    state = StateStore(str(tmp_path / "renewal.sqlite"))
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
    assert _standing_account_hold(state, INTEGRATION, GEN + 1, ACCOUNT) is not None  # any generation
    state.close()

    # The coordinator of the same account, at a later generation, restores from acknowledged progress.
    world = polling.world(monkeypatch, selection=polling.DRIVE_ROOTS, fail=None)
    world.progress = {key: copy.deepcopy(brain.progress[key]) for key in RESTRICTION_KEYS if key in brain.progress}
    assert polling.GENERATION != GEN
    poll_state = StateStore(str(tmp_path / "poll.sqlite"))
    summary = await run_gdrive_stream(polling.SETTINGS, polling.CONNECTION, poll_state)
    assert world.calls == []  # no Drive call while the account is held
    assert summary.failure_categories.get("rate_limited") == 1
    poll_state.close()


@pytest.mark.asyncio
async def test_a_failed_publication_keeps_the_local_hold_and_the_next_sweep_publishes_it(tmp_path, monkeypatch):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(429, LONG)]
    brain = _quota_brain(due=True)
    brain.checkpoint_faults.append(
        lambda payload: BrainError(503, "server_error", "brain unavailable") if payload.get("account_hold") else None,
    )
    brain.install(monkeypatch)
    path = str(tmp_path / "unpublished.sqlite")
    state = StateStore(path)

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    assert fake.calls == [("watch", "my-drive")]  # stopped even though publication failed
    assert _hold(state) is not None
    assert _published_hold(brain) is None  # never claimed remote-durable
    state.close()

    fake.calls.clear()
    state = StateStore(path)
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
    assert fake.calls == []
    assert _published_hold(brain) is not None and _published_hold(brain)[0] == _hold(state)[0]
    state.close()


def _stored_then(error):
    """A lost acknowledgment: the brain stores the document, and its answer never arrives."""

    def fault(brain, payload):
        brain.progress = json.loads(json.dumps(payload))
        brain.revision += 1
        return error()
    return fault


def _local_watch_state(state, attempt_id):
    row = state._db.execute(
        "SELECT state FROM webhook_channels WHERE channel_id=?", (attempt_id,),
    ).fetchone()
    return row["state"] if row else None


# The quota-rejected attempt's own RETIRED checkpoint fails — the exact boundary of R51 F2. Each answer:
# (fault given the brain and the payload, whether the brain stored the document, whether it cancels).
_RETIREMENT_FAILURES = [
    pytest.param(
        lambda brain, payload: BrainError(503, "server_error", "brain unavailable"), False, False,
        id="delivery-failure",
    ),
    pytest.param(
        lambda brain, payload: BrainError(409, "stale_execution", "replaced"), False, False,
        id="authority-refusal",
    ),
    pytest.param(lambda brain, payload: asyncio.TimeoutError(), False, False, id="timeout"),
    pytest.param(_stored_then(asyncio.TimeoutError), True, False, id="lost-acknowledgment"),
    pytest.param(lambda brain, payload: asyncio.CancelledError(), False, True, id="cancellation"),
]


@pytest.mark.parametrize("failure, stored, cancels", _RETIREMENT_FAILURES)
@pytest.mark.asyncio
async def test_a_creation_quota_hold_is_journaled_before_its_retirement_is_published(
    tmp_path, monkeypatch, failure, stored, cancels,
):
    """R51 F2: the hold is in the local journal BEFORE the quota-rejected attempt's retirement is
    published, so a failed, refused, unacknowledged or cancelled publication cannot lose it. That
    publication's own outcome ends the connection run unchanged: nothing is projected as
    acknowledged, no further watch call is made, the lease is released — and the local hold alone
    blocks polling and renewal until a fresh acquisition publishes it."""
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(429, LONG)]
    brain = _quota_brain(due=True)
    streams_before = copy.deepcopy(brain.progress["streams"])
    path = str(tmp_path / "retirement.sqlite")
    state = StateStore(path)
    held_at_checkpoint: list = []

    def at_quota_retirement(payload):
        records = (payload.get("watches") or {}).get("records") or []
        if not any(r.get("state") == RETIRED and r.get("detail") == "provider quota limited" for r in records):
            return None
        held_at_checkpoint.append(_hold(state))
        return failure(brain, payload)

    brain.checkpoint_faults.append(at_quota_retirement)
    brain.install(monkeypatch)
    started = datetime.now(timezone.utc)

    if cancels:
        with pytest.raises(asyncio.CancelledError):  # propagated, never replaced by the hold
            await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
    else:
        await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    # Journaled before the retirement checkpoint was even invoked, at the provider's deadline.
    assert len(held_at_checkpoint) == 1
    assert held_at_checkpoint[0] is not None
    assert _near(held_at_checkpoint[0][0], started + timedelta(seconds=int(LONG)))
    assert _hold(state) == held_at_checkpoint[0]
    # One creation — no second creation, no stop.
    assert fake.calls == [("watch", "my-drive")]
    assert _published_hold(brain) is None  # never claimed remote-durable
    records = brain.records()
    (attempt,) = [r for r in records.values() if r.predecessor == "current"]
    assert attempt.state == (RETIRED if stored else DISPATCHED)
    # The failed retirement is not projected locally as acknowledged.
    assert _local_watch_state(state, attempt.attempt_id) == DISPATCHED
    assert records["current"].state == ACTIVE  # the predecessor is untouched
    assert all(records[f"old{i}"].state == CLEANUP_PENDING for i in range(2))
    assert all(records[f"old{i}"].stop_attempts == 0 for i in range(2))
    assert brain.progress["streams"] == streams_before  # no cursor moved
    assert brain.events[-1] == "release"
    state.close()

    # Reopened: the local journal alone blocks polling's admission and renewal; the fresh acquisition
    # recovers the attempt without activating it and publishes the hold.
    state = StateStore(path)
    assert _standing_account_hold(state, INTEGRATION, GEN, ACCOUNT) is not None
    fake.calls.clear()
    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)
    assert fake.calls == []
    assert _published_hold(brain) is not None and _published_hold(brain)[0] == _hold(state)[0]
    records = brain.records()
    assert records[attempt.attempt_id].state in (UNCERTAIN, RETIRED)  # never active
    assert records[attempt.attempt_id].resource_id is None
    assert records["current"].state == ACTIVE
    assert all(records[f"old{i}"].state == CLEANUP_PENDING for i in range(2))
    assert all(records[f"old{i}"].stop_attempts == 0 for i in range(2))
    assert brain.progress["streams"] == streams_before
    assert brain.events[-1] == "release"
    state.close()


@pytest.mark.asyncio
async def test_under_the_uncertainty_latch_nothing_is_sent_and_the_local_hold_stands(tmp_path, monkeypatch):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(429, LONG)]
    brain = _quota_brain(due=True).install(monkeypatch)
    monkeypatch.setattr(
        watch_renewal.brain_client.BrainClient, "gdrive_progress_uncertain",
        lambda self, execution: True, raising=False,
    )
    state = StateStore(str(tmp_path / "uncertain.sqlite"))

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    assert fake.calls == [("watch", "my-drive")]
    assert _hold(state) is not None
    assert not any(document.get("account_hold") for document in brain.checkpoints)  # nothing sent
    state.close()


@pytest.mark.asyncio
async def test_another_credentials_hold_is_not_adopted_and_survives_the_publication(tmp_path, monkeypatch):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(429, LONG)]
    brain = _quota_brain(due=True)
    other_until = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
    evidence: dict = {}
    add_hold(evidence, "another-account", (other_until, "rate_limited"))
    apply_restriction_sections(brain.progress, restriction_sections(
        evidence, credential="another-account", generation=GEN, standing=_restriction_standing,
    ))
    brain.install(monkeypatch)
    state = StateStore(str(tmp_path / "isolation.sqlite"))

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    assert fake.calls == [("watch", "my-drive")]  # this account was not held by the other's hold
    assert _hold(state, "another-account") is None  # never adopted
    assert _published_hold(brain, "another-account") == (other_until, "rate_limited")  # carried
    assert _published_hold(brain) is not None
    state.close()


@pytest.mark.asyncio
async def test_a_lapsed_shorter_hold_is_replaced_and_a_later_shorter_one_never_shortens_it(tmp_path, monkeypatch):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [_GoogleError(429, LONG)]
    _quota_brain(due=True).install(monkeypatch)
    state = StateStore(str(tmp_path / "monotonic.sqlite"))
    lapsed = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    state.hold_connection(INTEGRATION, GEN, ACCOUNT, lapsed, "rate_limited")

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    held = _hold(state)
    assert held is not None and held[0] != lapsed
    shorter = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    assert state.hold_connection(INTEGRATION, GEN, ACCOUNT, shorter, "rate_limited") == held
    state.close()


@pytest.mark.parametrize("watch_answer, stop_answer, expect_calls", [
    pytest.param(_GoogleError(403), None, [("watch", "my-drive"), ("watch", "shared-x"), ("stop", "old0"), ("stop", "old1")],
                 id="permission-403-creation"),
    pytest.param(_GoogleError(500), None, [("watch", "my-drive"), ("watch", "shared-x"), ("stop", "old0"), ("stop", "old1")],
                 id="5xx-creation"),
    pytest.param(None, _GoogleError(500), [("watch", "my-drive"), ("watch", "shared-x"), ("stop", "old0"), ("stop", "old1")],
                 id="5xx-stop"),
])
@pytest.mark.asyncio
async def test_non_quota_watch_failures_are_never_account_holds(
    tmp_path, monkeypatch, watch_answer, stop_answer, expect_calls,
):
    fake = _fake_drive(monkeypatch)
    fake.watch_answers = [watch_answer] if watch_answer is not None else []
    fake.stop_answers = [stop_answer] if stop_answer is not None else []
    brain = _quota_brain(due=True).install(monkeypatch)
    state = StateStore(str(tmp_path / "control.sqlite"))

    await watch_renewal.renew_watches(state, _manager(), [_conn()], SETTINGS)

    assert fake.calls == expect_calls  # the sweep went on
    assert _hold(state) is None and _published_hold(brain) is None
    records = brain.records()
    if stop_answer is not None:
        assert records["old0"].state == CLEANUP_PENDING and records["old0"].stop_attempts == 1
    else:
        first = [r for r in records.values() if r.predecessor == "current" and r.attempt_id != "current"]
        assert first and first[0].state in (RETIRED, UNCERTAIN)
    state.close()
