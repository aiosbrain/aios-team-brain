"""A Drive notification is admitted only for a fully known, unexpired channel (AIO-1167 R44 C12).

Spec (AC-04 invalid callbacks). Active-notification admission requires the stored resource id, the
stored verification hash and a valid future expiration, and an exact match of the supplied
resource id and token. A missing stored piece refuses — a legacy row whose resource or hash is NULL
proves nothing about the caller — and so does an expired, missing or malformed expiration. An
invalid callback records no hint (so nothing is scheduled) and the receiver never calls the
provider or the brain. Two valid, overlapping channels (a renewal's predecessor and successor)
are both admitted. The pending-handshake evidence path is separate and is not touched here.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from aios_ingest.state import Channel, StateStore, StreamKey, verification_hash

TOKEN = "secret-token"
FUTURE = "2099-01-01T00:00:00Z"


def _iso(delta: timedelta) -> str:
    return (datetime.now(timezone.utc) + delta).isoformat()


@pytest.fixture()
def world(tmp_path, monkeypatch):
    path = tmp_path / "admission.sqlite"
    monkeypatch.setenv("AIOS_INGEST_STATE", str(path))
    state = StateStore(str(path))
    key = StreamKey("team", "connection-id", "subject:acct", "my-drive")
    progress = state.begin_generation(key, 3, start_token="start")
    yield state, progress
    state.close()


def _hints(state: StateStore) -> int:
    row = state._db.execute("SELECT COALESCE(SUM(dirty_seq),0) AS n FROM stream_hints").fetchone()
    return int(row["n"])


def _save(state, progress, channel_id, *, resource="res-1", expires=FUTURE, token_hash=None, namespace=None):
    state.save_channel(Channel(
        "docs", channel_id, resource, expires,
        progress.namespace if namespace is None else namespace,
        verification_hash(TOKEN) if token_hash is None else token_hash,
    ))


@pytest.mark.parametrize(
    "case, overrides",
    [
        ("stored resource id is NULL", {"resource": None}),
        ("stored resource id is empty", {"resource": ""}),
        ("stored verification hash is empty", {"token_hash": ""}),
        ("expiration is missing", {"expires": None}),
        ("expiration is malformed", {"expires": "next tuesday"}),
        ("expiration has passed", {"expires": _iso(timedelta(seconds=-1))}),
    ],
)
def test_an_incomplete_or_expired_channel_is_refused(world, case, overrides):
    state, progress = world
    _save(state, progress, "chan", **overrides)
    assert state.validate_notification(channel_id="chan", resource_id="res-1", verification_token=TOKEN) is None, case


@pytest.mark.parametrize(
    "resource_id, token",
    [("res-wrong", TOKEN), ("res-1", "wrong"), (None, TOKEN), ("res-1", None), ("", TOKEN)],
)
def test_a_mismatched_resource_or_token_is_refused(world, resource_id, token):
    state, progress = world
    _save(state, progress, "chan")
    assert state.validate_notification(channel_id="chan", resource_id=resource_id, verification_token=token) is None


def test_a_complete_unexpired_channel_is_admitted_and_overlapping_channels_both_are(world):
    state, progress = world
    _save(state, progress, "predecessor", resource="res-old", expires=_iso(timedelta(minutes=5)))
    _save(state, progress, "successor", resource="res-new", expires=_iso(timedelta(days=1)))
    assert state.validate_notification(channel_id="predecessor", resource_id="res-old", verification_token=TOKEN)
    assert state.validate_notification(channel_id="successor", resource_id="res-new", verification_token=TOKEN)
    # A naive (offset-less) expiration is read as UTC, not refused.
    _save(state, progress, "naive", expires=(datetime.now(timezone.utc) + timedelta(hours=1)).replace(tzinfo=None).isoformat())
    assert state.validate_notification(channel_id="naive", resource_id="res-1", verification_token=TOKEN)


def _notify(channel_id: str, resource_id: str, token: str):
    from aios_ingest.webhook_app import _gdrive_notification

    return _gdrive_notification({
        "x-goog-channel-id": channel_id, "x-goog-resource-id": resource_id, "x-goog-channel-token": token,
    })


@pytest.mark.parametrize(
    "overrides",
    [{"resource": None}, {"token_hash": ""}, {"expires": _iso(timedelta(seconds=-1))}, {"expires": "bogus"}],
)
def test_the_receiver_refuses_an_invalid_channel_and_schedules_nothing(world, monkeypatch, overrides):
    import httpx

    def no_network(*_args, **_kwargs):
        raise AssertionError("an invalid callback must make no provider or brain call")

    monkeypatch.setattr(httpx.Client, "send", no_network)
    monkeypatch.setattr(httpx.AsyncClient, "send", no_network)
    state, progress = world
    _save(state, progress, "chan", **overrides)
    response = _notify("chan", "res-1", TOKEN)
    assert response.status_code == 401
    assert _hints(state) == 0


def test_the_receiver_wakes_the_stream_for_a_valid_channel_and_is_truthful_without_one(world):
    state, progress = world
    _save(state, progress, "chan")
    response = _notify("chan", "res-1", TOKEN)
    assert response.status_code == 202 and response.body == b"Drive poll scheduled"
    assert _hints(state) == 1
    # A valid channel with no stream to wake is accepted, but does not claim a poll was scheduled.
    _save(state, progress, "legacy", resource="res-legacy", namespace="")
    legacy = _notify("legacy", "res-legacy", TOKEN)
    assert legacy.status_code == 202 and b"nothing to schedule" in legacy.body
    assert _hints(state) == 1
