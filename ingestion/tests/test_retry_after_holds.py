"""Provider Retry-After through the real coordinator: holds, restarts and admission (AIO-1167 R48 D2).

Spec (AC-04:230; Astra R47 D2). Each deferral below is the REAL provider owner's answer to an HTTP
response carrying the stated Retry-After (``provider_deferral``), driven through the real coordinator
in the root-metadata, start-token and document phases:

  * a valid delay — ordinary, an HTTP-date, or the long ``99999999`` — is held to the provider's
    deadline exactly: no provider call before it on retry, restart or a fresh state file restoring
    the brain's progress, and admission resumes once the represented deadline has passed;
  * malformed input is the bounded fallback with ``retry_after_malformed``; unrepresentable input is
    held at the last representable instant with ``retry_after_unrepresentable`` — the persisted
    progress stays valid JSON with ISO instants, and nothing completes falsely;
  * a document's own (non-quota) deferral keeps the provider's deadline as its earliest retry;
  * account holds merge monotonically: a shorter later hold, local or adopted, never shortens one.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from types import SimpleNamespace

import pytest

from aios_ingest.gdrive_sync import run_gdrive_stream
from aios_ingest.sources.gdrive import LATEST_INSTANT
from aios_ingest.state import StateStore
from test_account_hold_before_streams import (
    ACCOUNT, CONNECTION, DRIVE_ROOTS, FILE_ROOT, GENERATION, INTEGRATION, SETTINGS, world,
)

LATEST = LATEST_INSTANT.isoformat()


@pytest.fixture
def clock(monkeypatch):
    """The coordinator's clock, starting at the real present the provider owner computes from."""
    now = SimpleNamespace(at=datetime.now(timezone.utc))
    monkeypatch.setattr("aios_ingest.gdrive_sync._now", lambda: now.at.isoformat())
    return now


def _hold(state: StateStore) -> tuple[str, str] | None:
    return state.connection_hold(INTEGRATION, GENERATION, ACCOUNT)


def _assert_valid_progress(w) -> None:
    """The published document is JSON with ISO instants wherever a retry time is recorded."""
    json.dumps(w.progress)
    hold = w.progress.get("account_hold")
    if hold:
        datetime.fromisoformat(hold["not_before"])
    for stream in (w.progress.get("streams") or {}).values():
        if stream.get("retry_not_before"):
            datetime.fromisoformat(stream["retry_not_before"])


async def _held_without_a_call(w, path, clock_at, clock):
    before = list(w.calls)
    clock.at = clock_at
    state = StateStore(path)
    await run_gdrive_stream(SETTINGS, CONNECTION, state)
    state.close()
    assert w.calls == before, f"a provider call was made at {clock_at.isoformat()}"


@pytest.mark.parametrize("selection, phase", [(DRIVE_ROOTS, "start"), (FILE_ROOT, "metadata")])
@pytest.mark.parametrize("header", ["120", "http-date", "99999999"])
@pytest.mark.asyncio
async def test_a_valid_delay_is_held_to_exactly_its_deadline_then_admitted(
    tmp_path, monkeypatch, clock, selection, phase, header,
):
    target = (clock.at + timedelta(minutes=5)).replace(microsecond=0)
    value = format_datetime(target, usegmt=True) if header == "http-date" else header
    w = world(monkeypatch, selection=selection, fail=phase, retry_after=value)
    state = StateStore(str(tmp_path / "s.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    held = _hold(state)
    assert held is not None
    deadline = datetime.fromisoformat(held[0])
    if header == "http-date":
        assert deadline == target
    else:
        expected = clock.at + timedelta(seconds=int(header))
        assert abs((deadline - expected).total_seconds()) < 5  # the named delay, not shortened
    assert w.progress["account_hold"]["not_before"] == held[0]
    assert summary.failed == 0 and "retry_after_malformed" not in summary.failure_categories
    _assert_valid_progress(w)
    state.close()

    path = str(tmp_path / "s.sqlite")
    # Just before the represented deadline: restart, and a fresh state file restoring the brain.
    await _held_without_a_call(w, path, deadline - timedelta(seconds=1), clock)
    await _held_without_a_call(w, str(tmp_path / "fresh.sqlite"), deadline - timedelta(seconds=1), clock)
    # Just after it: admitted, and the work proceeds.
    w.fail = None
    clock.at = deadline + timedelta(seconds=1)
    state = StateStore(path)
    resumed = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert "rate_limited" not in resumed.failure_categories
    assert w.calls.count(phase) >= 2 and w.pushes
    state.close()


@pytest.mark.parametrize("value", ["soon", "nan", "inf", "-5", "1e999", "Wed, 31 Feb 2026 10:00:00 GMT"])
@pytest.mark.asyncio
async def test_malformed_input_is_a_bounded_fallback_hold_with_a_diagnostic(tmp_path, monkeypatch, clock, value):
    w = world(monkeypatch, selection=DRIVE_ROOTS, fail="start", retry_after=value)
    state = StateStore(str(tmp_path / "m.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert summary.failure_categories.get("retry_after_malformed") == 1
    assert summary.failure_categories.get("rate_limited") == 1 and summary.failed == 0
    held = _hold(state)
    assert held is not None
    deadline = datetime.fromisoformat(held[0])
    assert deadline <= datetime.now(timezone.utc) + timedelta(seconds=4.2)  # the bounded fallback
    _assert_valid_progress(w)
    state.close()

    w.fail = None
    clock.at = deadline + timedelta(seconds=1)
    state = StateStore(str(tmp_path / "m.sqlite"))
    resumed = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert "rate_limited" not in resumed.failure_categories and w.pushes
    state.close()


@pytest.mark.parametrize("selection, phase", [(DRIVE_ROOTS, "start"), (FILE_ROOT, "metadata")])
@pytest.mark.parametrize("value", ["9" * 30, "300000000000", "Fri, 31 Dec 99999 23:59:59 GMT"])
@pytest.mark.asyncio
async def test_unrepresentable_input_fails_closed_across_restart_and_restore(
    tmp_path, monkeypatch, clock, selection, phase, value,
):
    w = world(monkeypatch, selection=selection, fail=phase, retry_after=value)
    path = str(tmp_path / "u.sqlite")
    state = StateStore(path)

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert summary.failure_categories.get("retry_after_unrepresentable") == 1
    assert summary.authoritative_complete is False and w.pushes == []
    assert _hold(state) == (LATEST, "rate_limited")
    assert w.progress["account_hold"]["not_before"] == LATEST
    _assert_valid_progress(w)
    state.close()

    # Never retried early: not on restart, not from a fresh state file, not centuries from now.
    w.fail = None
    await _held_without_a_call(w, path, clock.at + timedelta(days=1), clock)
    await _held_without_a_call(w, str(tmp_path / "fresh.sqlite"), clock.at + timedelta(days=1), clock)
    await _held_without_a_call(w, path, datetime(9000, 1, 1, tzinfo=timezone.utc), clock)


@pytest.mark.asyncio
async def test_a_document_phase_rate_limit_holds_every_stream_to_the_long_deadline(tmp_path, monkeypatch, clock):
    w = world(monkeypatch, selection=DRIVE_ROOTS, fail="body", retry_after="99999999")
    path = str(tmp_path / "doc-rate.sqlite")
    state = StateStore(path)

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    held = _hold(state)
    assert held is not None
    deadline = datetime.fromisoformat(held[0])
    assert abs((deadline - (clock.at + timedelta(seconds=99999999))).total_seconds()) < 5
    assert summary.failed == 0 and summary.authoritative_complete is False
    for progress in state.list_progress(INTEGRATION, GENERATION):
        assert progress.retry_not_before == held[0]
    _assert_valid_progress(w)
    state.close()
    w.fail = None
    await _held_without_a_call(w, str(tmp_path / "doc-fresh.sqlite"), deadline - timedelta(days=1), clock)


def _owed_body(state: StateStore):
    return state._db.execute(
        "SELECT item_key, failures, not_before FROM pending_work "
        "WHERE acknowledged_at IS NULL AND superseded_at IS NULL ORDER BY item_key").fetchall()


@pytest.mark.parametrize("value, expect", [
    ("120", "deadline"), ("inf", "fallback"), ("9" * 30, "latest"),
])
@pytest.mark.asyncio
async def test_a_document_deferral_keeps_the_providers_deadline_as_its_earliest_retry(
    tmp_path, monkeypatch, clock, value, expect,
):
    w = world(monkeypatch, selection=DRIVE_ROOTS, fail="body", retry_after=value, status=503)
    state = StateStore(str(tmp_path / "doc.sqlite"))
    started = datetime.now(timezone.utc)

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    owed = _owed_body(state)
    assert owed, "the deferred document is still owed"
    assert summary.authoritative_complete is False and w.pushes == []
    for _item, failures, not_before in owed:
        if not_before is None:
            continue  # a document this run never reached
        retry_at = datetime.fromisoformat(not_before)
        if expect == "deadline":
            assert retry_at >= started + timedelta(seconds=119)  # never before the provider's deadline
        elif expect == "latest":
            assert not_before == LATEST
        else:
            assert retry_at.year == started.year  # a real, bounded instant
    if expect == "fallback":
        assert summary.failure_categories.get("retry_after_malformed", 0) >= 1
    if expect == "latest":
        assert summary.failure_categories.get("retry_after_unrepresentable", 0) >= 1
    state.close()


def test_account_holds_merge_monotonically(tmp_path):
    state = StateStore(str(tmp_path / "merge.sqlite"))
    long_deadline = "2029-12-01T00:00:00+00:00"
    assert state.hold_connection(INTEGRATION, GENERATION, ACCOUNT, long_deadline, "rate_limited") == (long_deadline, "rate_limited")
    # A shorter later hold never shortens a standing one.
    assert state.hold_connection(INTEGRATION, GENERATION, ACCOUNT, "2026-11-01T00:00:00+00:00", "rate_limited") == (long_deadline, "rate_limited")
    # A longer one extends it; the last representable instant is the ceiling and stays.
    assert state.hold_connection(INTEGRATION, GENERATION, ACCOUNT, LATEST, "rate_limited") == (LATEST, "rate_limited")
    assert state.hold_connection(INTEGRATION, GENERATION, ACCOUNT, long_deadline, "rate_limited") == (LATEST, "rate_limited")
    # A corrupt value never outranks a real instant.
    assert state.hold_connection(INTEGRATION, GENERATION, ACCOUNT, "not-a-time", "rate_limited") == (LATEST, "rate_limited")
    state.close()


@pytest.mark.parametrize("remote_offset, expect_remote", [(timedelta(days=30), True), (timedelta(minutes=1), False)])
@pytest.mark.asyncio
async def test_an_adopted_hold_extends_but_never_shortens_the_local_one(
    tmp_path, monkeypatch, clock, remote_offset, expect_remote,
):
    w = world(monkeypatch, selection=DRIVE_ROOTS, fail=None)
    local = (clock.at + timedelta(days=1)).isoformat()
    remote = (clock.at + remote_offset).isoformat()
    w.progress = {"account_hold": {
        "generation": GENERATION, "credential": ACCOUNT, "not_before": remote, "category": "rate_limited",
    }}
    state = StateStore(str(tmp_path / "adopt.sqlite"))
    state.hold_connection(INTEGRATION, GENERATION, ACCOUNT, local, "rate_limited")

    await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert w.calls == []  # held either way
    assert _hold(state)[0] == (remote if expect_remote else local)
    state.close()
