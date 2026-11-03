"""The account Retry-After hold from EVERY provider phase, through the real coordinator (AIO-1167 R45 H1).

Spec (AC-04 bounded recovery, AC-07 truthful diagnostics; adjudication H1). A provider rate limit is
the ACCOUNT's wait, wherever it is read: a document's metadata or body read during a baseline, the
baseline's own folder listing, or a change-page read. The real coordinator, running two Shared-Drive
streams through the real per-stream routine, must:

  * hold EVERY stream of the account until the provider's not-before — persisted, so a restart makes
    no provider call before it — and make no further provider call this run;
  * report the run partial with category ``rate_limited``, never ``provider_read``;
  * charge no document failure, retire no page, advance no cursor;
  * once the hold has passed, resume normally.

Before R45 the baseline converted the hold into ``baseline: _ProviderAdmissionClosed`` /
``provider_read`` and the next stream read the same account at once; enumeration and change-page
limits held only the one stream. A non-quota provider failure keeps its ordinary per-document
accounting (control).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from aios_ingest.brain_client import GdriveExecution, IngestResult
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.gdrive_sync import run_gdrive_stream
from aios_ingest.normalize import RawDoc
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import StateStore, StreamKey

INTEGRATION = "00000000-0000-0000-0000-0000000000b8"
GENERATION = 3
DRIVES = ("drive-a", "drive-b")
DOC_MIME = "application/vnd.google-apps.document"
T0 = datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc)
HOLD_UNTIL = (T0 + timedelta(hours=1)).isoformat()
SETTINGS = BrainSettings("http://brain", "key", "team")
CONNECTION = Connection("docs", "gdrive", options={"integration_id": INTEGRATION}, project="docs")


def _key(drive: str) -> StreamKey:
    return StreamKey("team", INTEGRATION, "account", drive)


def _ns(drive: str) -> str:
    return _key(drive).namespace(GENERATION)


@pytest.fixture
def clock(monkeypatch):
    now = SimpleNamespace(at=T0)
    monkeypatch.setattr("aios_ingest.gdrive_sync._now", lambda: now.at.isoformat())
    return now


def _rate_limited() -> ProviderDeferred:
    return ProviderDeferred("429 Too Many Requests", not_before=HOLD_UNTIL, category="rate_limited")


def world(monkeypatch, *, fail: str | None):
    """The real coordinator and stream routine; Google and the brain are fakes. ``fail`` names the
    ONE provider phase that answers a rate limit (until ``w.fail`` is cleared)."""
    w = SimpleNamespace(fail=fail, calls=[], pushes=[], progress={}, revision=0)

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
                raise _rate_limited()
            return request.execute()

        def _metadata(self, file_id):
            w.calls.append("metadata")
            if w.fail == "metadata":
                raise _rate_limited()
            drive = file_id.removeprefix("doc-")
            return {"id": file_id, "name": f"Doc {drive}", "mimeType": DOC_MIME, "driveId": drive,
                    "modifiedTime": "2026-10-30T00:00:00Z"}

        def _raw_doc(self, meta):
            w.calls.append("body")
            if w.fail == "body":
                raise _rate_limited()
            if w.fail == "body-unavailable":
                raise ProviderDeferred("503", not_before=None, category="provider_unavailable")
            return RawDoc(source="gdrive", external_id=meta["id"], title=meta["name"], body="body text")

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass

        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, GENERATION, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": [], "folderIds": [], "sharedDriveIds": list(DRIVES), "selectionState": "selected",
            }, progress=w.progress, progress_revision=w.revision)

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
            w.revision += 1
            w.progress = payload
            return {"progress_revision": w.revision, "progress": payload}

        async def push(self, item, *, execution=None):
            w.pushes.append(item.path)
            return IngestResult("created", f"item-{len(w.pushes)}", item.path)

        async def reconcile_gdrive(self, execution, **kwargs):
            return {"items": 0}

        async def release_gdrive_execution(self, execution): pass

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    return w


def _held(state: StateStore) -> list[str | None]:
    return [state.get_progress(_ns(drive)).retry_not_before for drive in DRIVES]


def _owed(state: StateStore):
    """(namespace, item, attempts, failures) of every owed document, and the uncommitted pages."""
    rows = state._db.execute(
        "SELECT namespace, item_key, attempts, failures, not_before, exhausted_at FROM pending_work "
        "WHERE acknowledged_at IS NULL AND superseded_at IS NULL ORDER BY item_key").fetchall()
    return [tuple(row) for row in rows]


def _seed_current_streams(state: StateStore) -> None:
    """Both streams already baselined and current, each with a cursor — the change-page phase."""
    for drive in DRIVES:
        progress = state.begin_generation(_key(drive), GENERATION, start_token=f"start:{drive}", phase="current")
        snapshot = state.begin_selection_snapshot(progress.namespace, GENERATION, [(drive, "drive", drive, True)])
        state.complete_traversal(progress.namespace, GENERATION, drive, drive, None, snapshot_id=snapshot)
        state.publish_selection_snapshot(progress.namespace, GENERATION, snapshot)
        state.update_progress(progress.namespace, listing_complete=True, page_token=f"cursor:{drive}")


def _assert_account_held(summary, state, w, *, provider_calls_after_limit: int = 0):
    assert summary.failure_categories.get("rate_limited") == 1
    assert "provider_read" not in summary.failure_categories
    assert summary.authoritative_complete is False
    assert _held(state) == [HOLD_UNTIL, HOLD_UNTIL]  # EVERY stream of the account, persisted
    # The brain's checkpoint carries the hold too, so a restore from it cannot drop it.
    published = [s.get("retry_not_before") for s in (w.progress.get("streams") or {}).values()]
    assert HOLD_UNTIL in published


@pytest.mark.parametrize("phase", ["metadata", "body", "list"])
@pytest.mark.asyncio
async def test_a_baseline_rate_limit_holds_the_account_and_resumes_after_it(tmp_path, monkeypatch, clock, phase):
    w = world(monkeypatch, fail=phase)
    state = StateStore(str(tmp_path / f"baseline-{phase}.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    _assert_account_held(summary, state, w)
    # Exactly one read answered the limit, and nothing was read after it: one listing of one
    # stream, and (for a document phase) one read of its one document.
    assert w.calls.count(phase) == 1
    assert w.calls[-1] == phase
    assert w.calls.count("list") == 1 and w.pushes == []
    if phase != "list":
        # The listed document is owed, uncharged and unacknowledged; its page is not retired.
        ((namespace, item, attempts, failures, not_before, exhausted),) = _owed(state)
        assert (attempts, failures, not_before, exhausted) == (0, 0, None, None)
        assert state.next_uncommitted_page(namespace, GENERATION) is not None
    assert summary.failed == 0

    # A restart BEFORE the hold makes no provider call at all.
    before = list(w.calls)
    clock.at = T0 + timedelta(minutes=30)
    held = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert w.calls == before and w.pushes == []
    assert held.authoritative_complete is False

    # After the hold, the account is read again and the work completes normally.
    clock.at = T0 + timedelta(hours=2)
    w.fail = None
    resumed = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert "rate_limited" not in resumed.failure_categories
    assert sorted(w.pushes) and len(w.pushes) == len(DRIVES)
    assert _owed(state) == []
    state.close()


@pytest.mark.asyncio
async def test_a_change_page_rate_limit_holds_every_stream_not_just_its_own(tmp_path, monkeypatch, clock):
    w = world(monkeypatch, fail="changes")
    state = StateStore(str(tmp_path / "changes.sqlite"))
    _seed_current_streams(state)
    cursors = [state.get_progress(_ns(drive)).page_token for drive in DRIVES]

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    _assert_account_held(summary, state, w)
    assert w.calls.count("changes") == 1 and w.calls[-1] == "changes"  # the second stream never read
    assert summary.failure_categories.get("rate_limited") == 1 and summary.failed == 0
    assert [state.get_progress(_ns(drive)).page_token for drive in DRIVES] == cursors  # no cursor moved

    before = list(w.calls)
    clock.at = T0 + timedelta(minutes=30)
    await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert w.calls == before

    clock.at = T0 + timedelta(hours=2)
    w.fail = None
    resumed = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert "rate_limited" not in resumed.failure_categories
    assert w.calls.count("changes") >= 1 + len(DRIVES)
    state.close()


@pytest.mark.asyncio
async def test_a_non_quota_body_failure_keeps_its_per_document_accounting(tmp_path, monkeypatch, clock):
    """Control: an ordinary provider failure is the document's, not the account's — no hold."""
    w = world(monkeypatch, fail="body-unavailable")
    state = StateStore(str(tmp_path / "unavailable.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert "rate_limited" not in summary.failure_categories
    assert summary.failure_categories.get("provider_unavailable", 0) >= 1
    assert _held(state) == [None, None]
    owed = _owed(state)
    assert owed and all(attempts == 1 and failures == 1 for _ns_, _item, attempts, failures, *_rest in owed)
    # Both streams were read: one document's failure did not stop the account.
    assert w.calls.count("list") == len(DRIVES)
    state.close()
