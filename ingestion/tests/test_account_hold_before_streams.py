"""The account Retry-After hold read BEFORE any stream exists (AIO-1167 R47 F5).

Spec (AC-04:230 bounded recovery, AC-07 truthful diagnostics; adjudication F5). A provider rate
limit read while binding a selected root (its metadata) or capturing a stream's start token is the
ACCOUNT's wait, exactly like one read during a drain — even though no stream exists yet to carry it.
Through the real coordinator:

  * the hold is persisted locally for this connection generation and verified account, and
    published onto the brain's acknowledged progress (nothing else in that document changes);
  * an immediate retry, a restart, and a fresh state file restoring the brain's progress all make
    NO provider call before the not-before;
  * the run reports a held (partial) run with the provider category — no document failure, no
    deletion evidence; after the deadline the work resumes;
  * a failed publication keeps the local hold and says so, never claiming remote durability;
  * a local budget stop is not a provider wait and opens no hold (control);
  * a hold recorded for another generation or account does not hold this one (scope);
  * a drain-phase hold also holds the next run's root and start-token reads.
"""

from __future__ import annotations

import copy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from aios_ingest.brain_client import BrainError, GdriveExecution, IngestResult
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.gdrive_sync import run_gdrive_stream
from aios_ingest.normalize import RawDoc
from aios_ingest.sources.gdrive import GoogleDriveSource as RealDriveSource
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import StateStore

INTEGRATION = "00000000-0000-0000-0000-0000000000f5"
GENERATION = 4
ACCOUNT = "account"
DOC_MIME = "application/vnd.google-apps.document"
T0 = datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc)
HOLD_UNTIL = (T0 + timedelta(hours=1)).isoformat()
SETTINGS = BrainSettings("http://brain", "key", "team")
CONNECTION = Connection("docs", "gdrive", options={"integration_id": INTEGRATION}, project="docs")

FILE_ROOT = {"fileIds": ["doc-drive-a"], "sharedDriveIds": []}
DRIVE_ROOTS = {"fileIds": [], "sharedDriveIds": ["drive-a", "drive-b"]}


@pytest.fixture
def clock(monkeypatch):
    now = SimpleNamespace(at=T0)
    monkeypatch.setattr("aios_ingest.gdrive_sync._now", lambda: now.at.isoformat())
    return now


def provider_deferral(status: int, retry_after: str | None) -> ProviderDeferred:
    """The ProviderDeferred the REAL provider-call owner raises for one HTTP answer — so the
    Retry-After is parsed and represented exactly as in production (AIO-1167 R48 D2)."""

    class Response:
        def __init__(self):
            self.status = status
            self.headers = {"Retry-After": retry_after} if retry_after is not None else {}

    class GoogleHttpError(Exception):
        resp = Response()

    def request():
        raise GoogleHttpError(f"HTTP {status}")

    source = RealDriveSource(
        file_ids=["any"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1, provider_retry_attempts=1,
    )
    try:
        source._provider_call(request)
    except ProviderDeferred as exc:
        return exc
    raise AssertionError("the provider call did not defer")


def world(
    monkeypatch, *, selection: dict, fail: str | None, category: str = "rate_limited",
    retry_after: str | None = None, status: int = 429,
):
    """The real coordinator; Google and the brain are fakes. ``fail`` names the ONE provider phase
    that answers ``category`` until it is cleared; ``checkpoint_error`` makes publication fail.
    With ``retry_after`` set, the deferral is the real provider owner's answer to HTTP ``status``
    carrying that Retry-After header (R48 D2)."""
    w = SimpleNamespace(fail=fail, calls=[], pushes=[], progress={}, revision=0, checkpoint_error=None)

    def deferred() -> ProviderDeferred:
        if retry_after is not None:
            return provider_deferral(status, retry_after)
        until = HOLD_UNTIL if category == "rate_limited" else None
        return ProviderDeferred("429 Too Many Requests", not_before=until, category=category)

    class Request:
        def __init__(self, kind, value):
            self.kind, self.value = kind, value

        def execute(self):
            return self.value

    class Changes:
        def getStartPageToken(self, **kwargs):
            return Request("start", {"startPageToken": f"start:{kwargs.get('driveId')}"})

        def list(self, **kwargs):
            return Request("changes", {"changes": [], "newStartPageToken": f"terminal:{kwargs.get('driveId')}"})

    class Files:
        def list(self, **kwargs):
            drive = kwargs.get("driveId")
            return Request("list", {"files": [{
                "id": f"doc-{drive}", "name": f"Doc {drive}", "mimeType": DOC_MIME, "driveId": drive,
                "modifiedTime": "2026-10-30T00:00:00Z",
            }]})

    class Drive:
        def changes(self): return Changes()
        def files(self): return Files()

    class Source:
        def __init__(self, **kwargs): pass
        def set_run_deadline(self, deadline): pass
        def _services(self): return Drive(), object()

        def _execute(self, request):
            w.calls.append(request.kind)
            if w.fail == request.kind:
                raise deferred()
            return request.execute()

        def _metadata(self, file_id):
            w.calls.append("metadata")
            if w.fail == "metadata":
                raise deferred()
            drive = file_id.removeprefix("doc-")
            return {"id": file_id, "name": f"Doc {drive}", "mimeType": DOC_MIME, "driveId": drive,
                    "modifiedTime": "2026-10-30T00:00:00Z", "parents": []}

        def _raw_doc(self, meta):
            w.calls.append("body")
            if w.fail == "body":
                raise deferred()
            return RawDoc(source="gdrive", external_id=meta["id"], title=meta["name"], body="body text")

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, GENERATION, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": ACCOUNT, "folderIds": [],
                "selectionState": "selected", **selection,
            }, progress=copy.deepcopy(w.progress), progress_revision=w.revision)  # a wire copy

        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": ACCOUNT}}

        def gdrive_token_provider(self, execution, grant):
            return SimpleNamespace(close=lambda: None)

        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()

        async def checkpoint_gdrive_execution(self, execution, payload):
            if w.checkpoint_error is not None:
                raise w.checkpoint_error
            w.revision += 1
            w.progress = copy.deepcopy(payload)
            return {"progress_revision": w.revision, "progress": copy.deepcopy(payload)}

        async def push(self, item, *, execution=None):
            w.pushes.append(item.path)
            return IngestResult("created", f"item-{len(w.pushes)}", item.path)

        async def reconcile_gdrive(self, execution, **kwargs):
            return {"items": 0}

        async def release_gdrive_execution(self, execution): pass

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    return w


def _owed_count(state: StateStore) -> int:
    return state._db.execute(
        "SELECT count(*) FROM pending_work WHERE acknowledged_at IS NULL AND superseded_at IS NULL",
    ).fetchone()[0]


def _assert_held_run(summary, w, *, phase: str) -> None:
    assert summary.failure_categories.get("rate_limited") == 1
    assert summary.failed == 0 and summary.skipped == 1
    assert summary.authoritative_complete is False
    assert w.calls.count(phase) == 1 and w.calls[-1] == phase  # nothing read after the limit
    assert w.pushes == []


@pytest.mark.parametrize("selection, phase", [(FILE_ROOT, "metadata"), (DRIVE_ROOTS, "start")])
@pytest.mark.asyncio
async def test_an_early_rate_limit_holds_the_account_across_retry_restart_and_restore(
    tmp_path, monkeypatch, clock, selection, phase,
):
    w = world(monkeypatch, selection=selection, fail=phase)
    state = StateStore(str(tmp_path / "first.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    _assert_held_run(summary, w, phase=phase)
    # Before ANY stream exists the hold is durable: locally, and on the brain.
    assert state.list_progress(INTEGRATION, GENERATION) == []
    assert state.connection_hold(INTEGRATION, GENERATION, ACCOUNT) == (HOLD_UNTIL, "rate_limited")
    assert w.progress["account_hold"] == {
        "generation": GENERATION, "credential": ACCOUNT, "not_before": HOLD_UNTIL, "category": "rate_limited",
    }
    assert _owed_count(state) == 0  # no document failure, no deletion evidence

    before = list(w.calls)
    clock.at = T0 + timedelta(minutes=10)
    # An immediate manual/scheduled retry on the same state.
    retry = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert w.calls == before
    assert retry.failure_categories == {"rate_limited": 1} and retry.failed == 0
    # A restart: the same state file reopened.
    state.close()
    state = StateStore(str(tmp_path / "first.sqlite"))
    await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert w.calls == before
    # Another state file, restoring only what the brain holds.
    fresh = StateStore(str(tmp_path / "restored.sqlite"))
    restored = await run_gdrive_stream(SETTINGS, CONNECTION, fresh)
    assert w.calls == before
    assert restored.failure_categories == {"rate_limited": 1}
    assert fresh.connection_hold(INTEGRATION, GENERATION, ACCOUNT) == (HOLD_UNTIL, "rate_limited")

    # After the deadline the account is read again and the work completes.
    clock.at = T0 + timedelta(hours=2)
    w.fail = None
    resumed = await run_gdrive_stream(SETTINGS, CONNECTION, fresh)
    assert "rate_limited" not in resumed.failure_categories
    assert w.calls.count(phase) >= 2
    assert w.pushes
    # The passed hold is no longer published.
    assert "account_hold" not in w.progress
    state.close()
    fresh.close()


@pytest.mark.asyncio
async def test_a_failed_publication_keeps_the_local_hold_and_says_so(tmp_path, monkeypatch, clock):
    w = world(monkeypatch, selection=DRIVE_ROOTS, fail="start")
    w.checkpoint_error = BrainError(503, "server_error", "brain unavailable")
    state = StateStore(str(tmp_path / "unpublished.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert summary.failure_categories == {"rate_limited": 1, "account_hold_unpublished": 1}
    assert summary.failed == 0
    assert state.connection_hold(INTEGRATION, GENERATION, ACCOUNT) == (HOLD_UNTIL, "rate_limited")
    assert "account_hold" not in w.progress  # never claimed remote-durable

    # This sidecar still honours its local hold.
    before = list(w.calls)
    clock.at = T0 + timedelta(minutes=10)
    w.checkpoint_error = None
    await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert w.calls == before
    state.close()


@pytest.mark.asyncio
async def test_a_local_budget_stop_opens_no_hold(tmp_path, monkeypatch, clock):
    """Control: the run's own deadline is not Google's wait."""
    w = world(monkeypatch, selection=DRIVE_ROOTS, fail="start", category="dispatch_deadline")
    state = StateStore(str(tmp_path / "budget.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert summary.failure_categories.get("dispatch_deadline") == 1
    assert state.connection_hold(INTEGRATION, GENERATION, ACCOUNT) is None
    assert "account_hold" not in w.progress
    w.fail = None
    await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert w.calls.count("start") >= 2  # the next run reads at once
    state.close()


@pytest.mark.parametrize("hold", [
    {"generation": GENERATION - 1, "credential": ACCOUNT, "not_before": HOLD_UNTIL, "category": "rate_limited"},
    {"generation": GENERATION, "credential": "another-account", "not_before": HOLD_UNTIL, "category": "rate_limited"},
])
@pytest.mark.asyncio
async def test_a_hold_for_another_generation_or_account_does_not_hold_this_one(
    tmp_path, monkeypatch, clock, hold,
):
    w = world(monkeypatch, selection=DRIVE_ROOTS, fail=None)
    w.progress = {"account_hold": hold}
    state = StateStore(str(tmp_path / "scoped.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert "rate_limited" not in summary.failure_categories
    assert w.calls.count("start") == 2
    assert state.connection_hold(INTEGRATION, GENERATION, ACCOUNT) is None
    state.close()


@pytest.mark.asyncio
async def test_a_drain_phase_hold_also_holds_the_next_runs_root_and_start_reads(tmp_path, monkeypatch, clock):
    w = world(monkeypatch, selection=DRIVE_ROOTS, fail="list")
    state = StateStore(str(tmp_path / "drain.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert summary.failure_categories.get("rate_limited") == 1
    assert state.connection_hold(INTEGRATION, GENERATION, ACCOUNT) == (HOLD_UNTIL, "rate_limited")
    assert w.progress["account_hold"]["not_before"] == HOLD_UNTIL
    # A fresh state file restoring the brain's progress makes no provider call — not even a
    # start-token capture for a stream its own state lacks.
    before = list(w.calls)
    clock.at = T0 + timedelta(minutes=10)
    fresh = StateStore(str(tmp_path / "drain-restored.sqlite"))
    await run_gdrive_stream(SETTINGS, CONNECTION, fresh)
    assert w.calls == before
    state.close()
    fresh.close()
