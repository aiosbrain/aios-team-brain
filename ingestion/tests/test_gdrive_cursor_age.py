"""AC-07 cursor age (AIO-1167, P2): the age of the last ACKNOWLEDGED DURABLE drain, not of an attempt.

Spec. ``cursor_age_seconds`` is the time since the *stalest* required stream of the current
generation last completed a durable drain the brain acknowledged — its ``last_success_at``, written
only after a clean terminal drain whose checkpoint the brain acknowledged and the acknowledged
all-stream reconciliation (or an empty selection's completed drain), restored from the brain on
recovery and kept across restart. It is never derived from ``last_attempt_at``: run entry, retries
and failures cannot refresh it, and one healthy stream cannot hide a stale one. It is unknown
(``None``), never zero, when any required stream lacks valid evidence. The clock is deterministic
throughout (``gdrive_sync._now`` is replaced).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from aios_ingest import gdrive_sync
from aios_ingest.brain_client import BrainError, GdriveExecution
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.engine import IngestSummary
from aios_ingest.gdrive_sync import (
    _roster_cursor_age_seconds,
    _run_gdrive_stream_unlocked,
    _stream_cursor_age_seconds,
    run_gdrive_stream,
)
from aios_ingest.state import StateStore, StreamKey

T0 = datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc)
INTEGRATION = "00000000-0000-0000-0000-0000000000a7"


class Clock:
    def __init__(self, start: datetime = T0):
        self.now = start

    def iso(self) -> str:
        return self.now.isoformat()

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


@pytest.fixture
def clock(monkeypatch):
    c = Clock()
    monkeypatch.setattr("aios_ingest.gdrive_sync._now", c.iso)
    return c


def stream(success=None, attempt=None):
    return SimpleNamespace(last_success_at=success, last_attempt_at=attempt)


# ── the definition, on its own ─────────────────────────────────────────────────────────────────


def test_age_is_since_the_oldest_success_across_the_roster():
    progresses = [stream((T0 - timedelta(minutes=5)).isoformat()), stream((T0 - timedelta(days=2)).isoformat())]
    assert _stream_cursor_age_seconds(progresses, now=T0) == pytest.approx(2 * 86_400)


def test_a_healthy_stream_never_masks_a_stale_one_and_attempts_never_count():
    # The stale stream was ATTEMPTED a second ago; the healthy one succeeded a minute ago.
    healthy = stream((T0 - timedelta(minutes=1)).isoformat(), attempt=T0.isoformat())
    stale = stream((T0 - timedelta(hours=6)).isoformat(), attempt=(T0 - timedelta(seconds=1)).isoformat())
    assert _stream_cursor_age_seconds([healthy, stale], now=T0) == pytest.approx(6 * 3600)
    assert _stream_cursor_age_seconds([stale, healthy], now=T0) == pytest.approx(6 * 3600)


@pytest.mark.parametrize("value", [
    None, "", "   ", "not-a-time", "2026-13-40T00:00:00+00:00", "2026-10-01T11:00:00",  # naive
    12345, (T0 + timedelta(minutes=1)).isoformat(),  # in the future
])
@pytest.mark.parametrize("valid_first", [True, False], ids=["valid-then-bad", "bad-then-valid"])
def test_missing_or_malformed_success_evidence_is_unknown_never_zero(value, valid_first):
    good = stream((T0 - timedelta(minutes=1)).isoformat())
    bad = stream(value)
    progresses = [good, bad] if valid_first else [bad, good]
    assert _stream_cursor_age_seconds(progresses, now=T0) is None


@pytest.mark.parametrize("order", ["past-then-future", "future-then-past"])
def test_a_future_success_on_any_required_stream_is_unknown_whatever_the_order(order):
    past = stream((T0 - timedelta(hours=2)).isoformat())
    future = stream((T0 + timedelta(minutes=5)).isoformat())
    progresses = [past, future] if order == "past-then-future" else [future, past]
    # The past stream alone would report two hours; the future one makes the whole roster unknown.
    assert _stream_cursor_age_seconds([past], now=T0) == pytest.approx(2 * 3600)
    assert _stream_cursor_age_seconds(progresses, now=T0) is None


def test_a_success_exactly_now_is_valid_and_zero():
    assert _stream_cursor_age_seconds([stream(T0.isoformat())], now=T0) == pytest.approx(0)


def test_a_required_stream_without_progress_or_an_empty_roster_is_unknown():
    assert _stream_cursor_age_seconds([stream((T0 - timedelta(minutes=1)).isoformat()), None], now=T0) is None
    assert _stream_cursor_age_seconds([], now=T0) is None


def test_a_never_successful_stream_with_recent_attempts_is_unknown():
    assert _stream_cursor_age_seconds([stream(None, attempt=T0.isoformat())], now=T0) is None


# ── state: exact roster, generation and restart ────────────────────────────────────────────────


def seeded(state, drive, generation, success=None, attempt=None, credential="account"):
    key = StreamKey("team", INTEGRATION, credential, drive)
    progress = state.begin_generation(key, generation, start_token="start", phase="current")
    changes = {}
    if success is not None:
        changes["last_success_at"] = success
    if attempt is not None:
        changes["last_attempt_at"] = attempt
    if changes:
        state.update_progress(progress.namespace, **changes)
    return progress


def test_roster_reads_only_this_generations_and_this_credentials_streams_and_survives_restart(tmp_path):
    path = str(tmp_path / "cursor-age.sqlite")
    state = StateStore(path)
    seeded(state, "drive-a", 7, success=(T0 - timedelta(minutes=10)).isoformat())
    # Generation 6's success and another credential's success are not evidence for generation 7.
    seeded(state, "drive-b", 6, success=(T0 - timedelta(minutes=1)).isoformat())
    seeded(state, "drive-b", 7, success=None, credential="other-account")
    assert _roster_cursor_age_seconds(state, "team", INTEGRATION, "account", 7, ["drive-a"], now=T0) == pytest.approx(600)
    assert _roster_cursor_age_seconds(state, "team", INTEGRATION, "account", 7, ["drive-a", "drive-b"], now=T0) is None
    seeded(state, "drive-b", 7, success=(T0 - timedelta(hours=1)).isoformat())
    assert _roster_cursor_age_seconds(state, "team", INTEGRATION, "account", 7, ["drive-a", "drive-b"], now=T0) == pytest.approx(3600)
    state.close()

    # A restart keeps the durable evidence; the age simply grows.
    reopened = StateStore(path)
    later = T0 + timedelta(minutes=5)
    assert _roster_cursor_age_seconds(reopened, "team", INTEGRATION, "account", 7, ["drive-a", "drive-b"], now=later) == pytest.approx(3900)
    reopened.close()


@pytest.mark.asyncio
async def test_remote_checkpoint_recovery_restores_the_acknowledged_success_and_its_attempt_does_not_refresh_it(tmp_path, clock):
    """A sidecar with no local state recovers its stream from the brain's checkpoint."""
    acknowledged = (T0 - timedelta(hours=3)).isoformat()

    class Unavailable(Exception):
        resp = SimpleNamespace(status=404)

    class StartRequest:
        def execute(self):
            raise Unavailable("drive gone")

    class Changes:
        def getStartPageToken(self, **_kwargs):
            return StartRequest()

    class Drive:
        def changes(self):
            return Changes()

    class Source:
        def _execute(self, request):
            return request.execute()

    class Client:
        revision = 4

        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": payload}

    remote = {
        "version": 2,
        "streams": {"drive-a": {
            "phase": "current", "drive_id": "drive-a", "baseline_start_token": "start",
            "page_token": "terminal", "listing_complete": True, "active_snapshot": 1,
            "checkpoint_id": "page-1", "last_attempt_at": acknowledged, "last_success_at": acknowledged,
        }},
    }
    execution = GdriveExecution(INTEGRATION, 9, 1, "owner", "later", "scope", {}, progress=remote, progress_revision=4)
    state = StateStore(str(tmp_path / "fresh.sqlite"))
    namespace = StreamKey("team", INTEGRATION, "account", "drive-a").namespace(9)
    assert state.get_progress(namespace) is None

    await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=Client(), execution=execution,
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=9, drive_id="drive-a",
        namespace=namespace, max_work=0,
    )

    recovered = state.get_progress(namespace)
    assert recovered.last_success_at == acknowledged
    # The recovery ATTEMPT is recorded, and it is not the metric.
    assert recovered.last_attempt_at == clock.iso()
    assert _roster_cursor_age_seconds(state, "team", INTEGRATION, "account", 9, ["drive-a"]) == pytest.approx(3 * 3600)
    state.close()


# ── the full run ────────────────────────────────────────────────────────────────────────────────


def world_for(monkeypatch, *, generation=6, drives=("drive-a", "drive-b"), selection="selected"):
    world = SimpleNamespace(
        generation=generation, drives=list(drives), selection=selection,
        reconcile=[], fail_finalize=False, stalled=set(), reconciles=0, checkpoints=0,
    )

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, world.generation, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": [], "folderIds": [], "sharedDriveIds": list(world.drives),
                "selectionState": world.selection,
            })

        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": "account"}}

        def gdrive_token_provider(self, execution, grant):
            return SimpleNamespace(close=lambda: None)

        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()

        async def checkpoint_gdrive_execution(self, execution, payload):
            if world.fail_finalize and payload.get("phase") == "current":
                raise BrainError(503, "checkpoint_unavailable", "the brain did not acknowledge the checkpoint")
            world.checkpoints += 1
            return {"progress_revision": world.checkpoints, "progress": payload}

        async def reconcile_gdrive(self, execution, **kwargs):
            world.reconciles += 1
            outcome = world.reconcile.pop(0) if world.reconcile else {"items": 0}
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        async def release_gdrive_execution(self, execution): pass

    class Changes:
        def getStartPageToken(self, **kwargs):
            return SimpleNamespace(execute=lambda: {"startPageToken": f"start:{kwargs.get('driveId')}"})

    class Drive:
        def changes(self): return Changes()

    class Source:
        def __init__(self, **kwargs): pass
        def set_run_deadline(self, deadline): pass
        def _services(self): return Drive(), object()
        def _execute(self, request): return request.execute()

    async def stream_run(_settings, _conn, state, **kwargs):
        namespace, generation, drive_id = kwargs["namespace"], kwargs["generation"], kwargs["drive_id"]
        # Every run attempts every stream — exactly what used to refresh the metric.
        state.update_progress(namespace, last_attempt_at=gdrive_sync._now())
        if drive_id in world.stalled:
            return IngestSummary("docs", failure_categories={})
        if state.get_progress(namespace).active_snapshot is None:
            snapshot = state.begin_selection_snapshot(namespace, generation, [])
            state.publish_selection_snapshot(namespace, generation, snapshot)
        state.update_progress(
            namespace, listing_complete=True, page_token="terminal",
            checkpoint_id="terminal-page", terminal_drain_token="terminal",
            terminal_drain_checkpoint_id="terminal-page", terminal_drain_acknowledged=True,
            drain_observation=1, terminal_drain_observation=1,
        )
        return IngestSummary("docs", failure_categories={})

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", stream_run)
    return world


SETTINGS = BrainSettings("http://brain", "key", "team")
CONNECTION = Connection("docs", "gdrive", options={"integration_id": INTEGRATION})


def failure():
    return BrainError(500, "reconcile_failed", "reconciliation failed")


@pytest.mark.asyncio
async def test_repeated_failures_never_refresh_it_and_only_an_acknowledged_success_does(tmp_path, monkeypatch, clock):
    world = world_for(monkeypatch)
    state = StateStore(str(tmp_path / "failures.sqlite"))

    world.reconcile = [failure()]
    first = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert first.authoritative_complete is False
    assert first.cursor_age_seconds is None  # never succeeded: unknown, not zero

    clock.advance(60)
    world.reconcile = [failure()]
    second = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert second.cursor_age_seconds is None

    clock.advance(60)
    success = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert success.authoritative_complete is True
    assert success.cursor_age_seconds == pytest.approx(0)

    for elapsed in (600, 1200):
        clock.now = T0 + timedelta(seconds=120 + elapsed)
        world.reconcile = [failure()]
        failed = await run_gdrive_stream(SETTINGS, CONNECTION, state)
        assert failed.authoritative_complete is False
        # Every stream was attempted just now; the metric still counts from the last success.
        attempts = {p.last_attempt_at for p in state.list_progress(INTEGRATION, 6)}
        assert attempts == {clock.iso()}
        assert failed.cursor_age_seconds == pytest.approx(elapsed)
    state.close()


@pytest.mark.asyncio
async def test_one_healthy_and_one_stale_stream_reports_the_stale_one(tmp_path, monkeypatch, clock):
    world = world_for(monkeypatch)
    state = StateStore(str(tmp_path / "mixed.sqlite"))
    seeded(state, "drive-a", 6, success=(T0 - timedelta(minutes=2)).isoformat())
    seeded(state, "drive-b", 6, success=(T0 - timedelta(days=1)).isoformat())
    world.stalled = {"drive-b"}

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert world.reconciles == 0 and summary.authoritative_complete is False
    # drive-b was attempted this very instant; it is still a day stale.
    assert state.get_progress(StreamKey("team", INTEGRATION, "account", "drive-b").namespace(6)).last_attempt_at == clock.iso()
    assert summary.cursor_age_seconds == pytest.approx(86_400)
    state.close()


@pytest.mark.asyncio
async def test_a_required_stream_that_never_succeeded_makes_it_unknown(tmp_path, monkeypatch, clock):
    world = world_for(monkeypatch)
    state = StateStore(str(tmp_path / "never.sqlite"))
    seeded(state, "drive-a", 6, success=(T0 - timedelta(minutes=2)).isoformat())
    seeded(state, "drive-b", 6, success=None, attempt=(T0 - timedelta(seconds=5)).isoformat())
    world.stalled = {"drive-b"}

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert summary.cursor_age_seconds is None
    state.close()


@pytest.mark.asyncio
async def test_malformed_stored_success_evidence_makes_it_unknown(tmp_path, monkeypatch, clock):
    world = world_for(monkeypatch)
    state = StateStore(str(tmp_path / "malformed.sqlite"))
    seeded(state, "drive-a", 6, success=(T0 - timedelta(minutes=2)).isoformat())
    seeded(state, "drive-b", 6, success="yesterday-ish")
    world.stalled = {"drive-b"}

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert summary.cursor_age_seconds is None
    state.close()


@pytest.mark.asyncio
async def test_a_failed_checkpoint_acknowledgment_does_not_refresh_it(tmp_path, monkeypatch, clock):
    world = world_for(monkeypatch)
    state = StateStore(str(tmp_path / "unacked.sqlite"))
    await run_gdrive_stream(SETTINGS, CONNECTION, state)  # a real success at T0
    previous = {p.last_success_at for p in state.list_progress(INTEGRATION, 6)}
    assert previous == {T0.isoformat()}

    clock.advance(900)
    world.fail_finalize = True
    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    # The reconciliation was acknowledged, but the success checkpoint was not: nothing is fresher.
    assert world.reconciles == 2
    assert {p.last_success_at for p in state.list_progress(INTEGRATION, 6)} == previous
    assert summary.cursor_age_seconds == pytest.approx(900)
    state.close()


@pytest.mark.asyncio
async def test_a_generation_change_starts_unknown_until_that_generation_succeeds(tmp_path, monkeypatch, clock):
    world = world_for(monkeypatch)
    state = StateStore(str(tmp_path / "generations.sqlite"))
    assert (await run_gdrive_stream(SETTINGS, CONNECTION, state)).cursor_age_seconds == pytest.approx(0)

    clock.advance(300)
    world.generation = 7
    world.reconcile = [failure()]
    changed = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    # Generation 6's success says nothing about generation 7's cursors.
    assert changed.cursor_age_seconds is None

    clock.advance(300)
    settled = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert settled.authoritative_complete is True
    assert settled.cursor_age_seconds == pytest.approx(0)
    state.close()


@pytest.mark.asyncio
async def test_an_empty_selection_is_fresh_only_after_its_acknowledged_empty_drain(tmp_path, monkeypatch, clock):
    world = world_for(monkeypatch, drives=(), selection="empty")
    state = StateStore(str(tmp_path / "empty.sqlite"))

    world.reconcile = [failure()]
    unacknowledged = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert unacknowledged.backlog == 1
    assert unacknowledged.cursor_age_seconds is None

    clock.advance(30)
    drained = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert drained.authoritative_complete is True and drained.backlog == 0
    assert drained.cursor_age_seconds == pytest.approx(0)

    clock.advance(45)
    world.reconcile = [failure()]
    later = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert later.cursor_age_seconds == pytest.approx(45)
    state.close()
