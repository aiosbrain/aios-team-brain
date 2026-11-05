"""Watch renewal honours the verified account's provider hold (AIO-1167 R51 blind-final 3).

Spec (accepted-spec AC-04:226,230; Astra R51 blind-final adjudication). After verified account
resolution and before any watch creation or cleanup call, renewal adopts the brain's acknowledged
minimums for THIS account through the coordinator's restriction owner and enforces a standing
account hold, local or acknowledged. Through the real ``renew_watches`` over the lifecycle doubles:

  * a due creation and a due cleanup make ZERO provider calls before the hold expires — with the
    hold retained in local state, or only in the brain's progress (a fresh state file);
  * existing channel records, their evidence and every cursor are unchanged while held;
  * after expiry, the same sweep creates and stops normally;
  * another credential's hold is never adopted for this account;
  * a hold observed under an earlier generation of the same account still holds.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from aios_ingest import watch_renewal
from aios_ingest.connector_state import add_hold, apply_restriction_sections, restriction_sections
from aios_ingest.gdrive_sync import _restriction_standing
from aios_ingest.state import StateStore
from aios_ingest.watch_lifecycle import ACTIVE, CLEANUP_PENDING, RETIRED, to_section
from test_watch_lifecycle import ACCOUNT, INTEGRATION, SETTINGS, _Brain, _conn, _Provider, _record

GEN = 3  # the generation the lifecycle brain double acquires
HOLD_UNTIL = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
AFTER_HOLD = datetime.now(timezone.utc) + timedelta(days=3)


def _publish_hold(brain: _Brain, credential: str, *, generation: int = GEN) -> None:
    """The brain's acknowledged progress carries ``credential``'s account hold, as a coordinator
    checkpoint publishes it (built by the production section owner)."""
    evidence: dict = {}
    add_hold(evidence, credential, (HOLD_UNTIL, "rate_limited"))
    apply_restriction_sections(brain.progress, restriction_sections(
        evidence, credential=credential, generation=generation, standing=_restriction_standing,
    ))


def _cleanup_record():
    return _record(
        CLEANUP_PENDING, attempt_id="old", resource_id="res-old",
        expires_at=(datetime.now(timezone.utc) + timedelta(days=5)).isoformat(),
    )


def _after_the_hold(monkeypatch):
    monkeypatch.setattr("aios_ingest.gdrive_sync._now", lambda: AFTER_HOLD.isoformat())


@pytest.mark.parametrize("where", ["retained-local", "acknowledged-only"])
@pytest.mark.asyncio
async def test_a_due_creation_makes_no_provider_call_until_the_hold_expires(tmp_path, monkeypatch, where):
    brain = _Brain()
    if where == "acknowledged-only":
        _publish_hold(brain, ACCOUNT)
    brain.install(monkeypatch)
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / f"create-{where}.sqlite"))
    if where == "retained-local":
        state.hold_connection(INTEGRATION, GEN, ACCOUNT, HOLD_UNTIL, "rate_limited")
    progress_before = dict(brain.progress)

    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)

    assert provider.dispatched == [] and provider.stopped == []
    assert "gate" not in brain.events
    assert brain.records() == {}  # no intent was even prepared
    assert brain.progress["streams"] == progress_before["streams"]  # cursors untouched
    assert state.connection_hold(INTEGRATION, GEN, ACCOUNT) == (HOLD_UNTIL, "rate_limited")
    assert brain.events[-1] == "release"

    _after_the_hold(monkeypatch)
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert len(provider.dispatched) == 1
    (created,) = brain.records().values()
    assert created.state == ACTIVE
    state.close()


@pytest.mark.parametrize("where", ["retained-local", "acknowledged-only"])
@pytest.mark.asyncio
async def test_a_due_cleanup_makes_no_stop_call_and_keeps_the_old_channel_until_the_hold_expires(
    tmp_path, monkeypatch, where,
):
    brain = _Brain()
    old = _cleanup_record()
    # An active successor that is not due, so this sweep would only clean up.
    current = _record(
        ACTIVE, attempt_id="current", resource_id="res-current",
        expires_at=(datetime.now(timezone.utc) + timedelta(days=6)).isoformat(),
    )
    brain.progress["watches"] = to_section({"old": old, "current": current})
    if where == "acknowledged-only":
        _publish_hold(brain, ACCOUNT)
    brain.install(monkeypatch)
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / f"cleanup-{where}.sqlite"))
    if where == "retained-local":
        state.hold_connection(INTEGRATION, GEN, ACCOUNT, HOLD_UNTIL, "rate_limited")

    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)

    assert provider.stopped == [] and provider.dispatched == []
    records = brain.records()
    assert records["old"].state == CLEANUP_PENDING and records["old"].resource_id == "res-old"
    assert records["old"].stop_attempts == old.stop_attempts  # no attempt was spent
    assert records["current"].state == ACTIVE

    _after_the_hold(monkeypatch)
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert provider.stopped == [("old", "res-old")]
    assert brain.records()["old"].state == RETIRED
    state.close()


@pytest.mark.asyncio
async def test_another_credentials_hold_is_never_adopted(tmp_path, monkeypatch):
    brain = _Brain()
    _publish_hold(brain, "another-account")
    brain.install(monkeypatch)
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / "cross.sqlite"))

    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)

    assert len(provider.dispatched) == 1  # this account is not held
    assert state.connection_hold(INTEGRATION, GEN, ACCOUNT) is None
    state.close()


@pytest.mark.parametrize("where", ["retained-local", "acknowledged-only"])
@pytest.mark.asyncio
async def test_a_hold_from_an_earlier_generation_of_the_same_account_still_holds(tmp_path, monkeypatch, where):
    brain = _Brain()
    if where == "acknowledged-only":
        _publish_hold(brain, ACCOUNT, generation=GEN - 1)
    brain.install(monkeypatch)
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / f"generation-{where}.sqlite"))
    if where == "retained-local":
        state.hold_connection(INTEGRATION, GEN - 1, ACCOUNT, HOLD_UNTIL, "rate_limited")

    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)

    assert provider.dispatched == []
    assert state.connection_hold(INTEGRATION, GEN, ACCOUNT) == (HOLD_UNTIL, "rate_limited")
    state.close()
