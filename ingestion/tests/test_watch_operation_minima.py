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

import copy
import dataclasses
from datetime import datetime, timedelta, timezone

import pytest

from aios_ingest import watch_renewal
from aios_ingest.state import StateStore, StreamKey
from aios_ingest.watch_lifecycle import ACTIVE, CLEANUP_PENDING, UNCERTAIN, from_section, to_section
from test_watch_lifecycle import ACCOUNT, INTEGRATION, SETTINGS, _conn
from test_watch_quota_hold import GEN, LONG, _fake_drive, _GoogleError, _manager, _quota_brain


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
