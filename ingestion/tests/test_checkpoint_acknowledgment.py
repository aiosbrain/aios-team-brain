"""A checkpoint the brain committed but whose acknowledgment was lost (AIO-1167 R47 F3).

Spec (AC-03 durable acknowledgment/replay, AC-04/07 truthful failure accounting; adjudication F3).
After a document's content is ACCEPTED, its checkpoint is control-plane work. When the brain commits
that checkpoint but every bounded acknowledgment is lost (a transport exception, or 5xx answers),
the sidecar's progress revision is unknown. Through the real coordinator and the REAL ``BrainClient``
revision owner, against a brain double with the brain's actual revision semantics (commit on the
expected revision; acknowledge an exact replay of what it holds; ``stale_progress`` otherwise):

  * no document failure is charged and nothing is exhausted, however many runs lose it;
  * the document is not acknowledged and its page not retired before the brain's acknowledgment;
  * no further checkpoint is SENT this run once the revision is uncertain — no different checkpoint
    under a guessed revision, so no sibling stream, root or watch state can regress;
  * the run ends partial; the next acquisition restores the brain's progress and the owed work
    replays idempotently to completion;
  * a lost transport response that a retry of the IDENTICAL payload acknowledges is no uncertainty;
  * a superseded execution is still run-terminal.

One 504 followed by a normal identical retry is not this defect (the brain already acknowledges an
identical replay); every case here loses ALL bounded acknowledgments.
"""

from __future__ import annotations

import copy
import json
from types import SimpleNamespace

import httpx
import pytest

from aios_ingest.brain_client import BrainClient, IngestResult
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.gdrive_sync import run_gdrive_stream
from aios_ingest.normalize import RawDoc
from aios_ingest.state import StateStore

INTEGRATION = "00000000-0000-0000-0000-0000000000f3"
GENERATION = 5
DOC_MIME = "application/vnd.google-apps.document"
SETTINGS = BrainSettings("http://brain", "aios_key_secret", "team")
CONNECTION = Connection("docs", "gdrive", options={"integration_id": INTEGRATION}, project="docs")
DOCS = {"drive-a": ["a1", "a2"], "drive-b": ["b1"]}
MAX_ATTEMPTS = 6  # brain_client._GDRIVE_CHECKPOINT_MAX_ATTEMPTS


def world(monkeypatch):
    """``w.losing`` = None | "exception" | "503": while set, the brain COMMITS a valid checkpoint and
    then loses every response. ``w.lose_after_pushes`` arms it once that many documents were pushed."""
    w = SimpleNamespace(
        progress={}, revision=0, fence=0, losing=None, lose_after_pushes=None, armed_mode=None,
        commits=[], checkpoint_requests=[], pushes=[], clock=1000.0, terminal=None,
        unreadable=set(), reconciles=[],
    )

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        action = body.get("action")
        if action == "acquire":
            w.fence += 1
            w.losing = None  # a fresh run: what was lost is restored by this acquisition
            if w.armed_mode and w.lose_after_pushes is None:
                w.losing = w.armed_mode
            return httpx.Response(200, json={
                "integration_id": INTEGRATION, "generation": GENERATION, "fence": w.fence,
                "owner": body["owner"], "lease_expires_at": "later", "scope_hash": "scope",
                "config": {
                    "authMode": "oauth", "authenticatedAccountId": "account", "fileIds": [],
                    "folderIds": [], "sharedDriveIds": list(DOCS), "selectionState": "selected",
                },
                "progress": copy.deepcopy(w.progress), "progress_revision": w.revision,
            })
        if action == "release":
            return httpx.Response(200, json={})
        assert action == "checkpoint", action
        w.checkpoint_requests.append(body)
        if w.terminal is not None:
            return httpx.Response(409, json={"error": {"code": w.terminal, "message": "superseded"}})
        expected, payload = int(body["progress_revision"]), body["progress"]
        if expected == w.revision:
            w.revision += 1
            w.progress = copy.deepcopy(payload)
            w.commits.append(copy.deepcopy(payload))
        elif not (expected < w.revision and payload == w.progress):
            return httpx.Response(409, json={"error": {"code": "stale_progress", "message": "stale"}})
        if w.losing == "exception":
            raise httpx.ReadTimeout("acknowledgment lost", request=request)
        if w.losing == "503":
            return httpx.Response(503, json={"error": {"code": "unavailable", "message": "lost"}})
        return httpx.Response(200, json={"progress_revision": w.revision, "progress": copy.deepcopy(w.progress)})

    async def sleep(delay):
        w.clock += delay

    class Client(BrainClient):
        """The real revision/uncertainty owner on the wire; Google-facing calls are doubles."""

        def __init__(self, *args, **kwargs):
            super().__init__(SETTINGS.base_url, SETTINGS.api_key, SETTINGS.team,
                             sleep=sleep, random_fn=lambda: 0, monotonic_fn=lambda: w.clock)
            self._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": "account"}}

        def gdrive_token_provider(self, execution, grant):
            return SimpleNamespace(close=lambda: None)

        def gdrive_provider_gate(self, execution):
            return SimpleNamespace(close=lambda: None, __call__=lambda: None)

        async def push(self, item, *, execution=None):
            w.pushes.append(item.path)
            if w.lose_after_pushes is not None and len(w.pushes) >= w.lose_after_pushes:
                w.losing = w.armed_mode
            return IngestResult("created", f"item-{len(w.pushes)}", item.path)

        async def reconcile_gdrive(self, execution, **kwargs):
            w.reconciles.append(kwargs)
            return {"items": 0}

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
                "id": doc, "name": f"Doc {doc}", "mimeType": DOC_MIME, "driveId": drive,
                "modifiedTime": "2026-10-30T00:00:00Z",
            } for doc in DOCS[drive]]})

    class Drive:
        def changes(self): return Changes()
        def files(self): return Files()

    class Source:
        def __init__(self, **kwargs): pass
        def set_run_deadline(self, deadline): pass
        def _services(self): return Drive(), object()
        def _execute(self, request): return request.execute()

        def _metadata(self, file_id):
            drive = next(d for d, docs in DOCS.items() if file_id in docs)
            return {"id": file_id, "name": f"Doc {file_id}", "mimeType": DOC_MIME, "driveId": drive,
                    "modifiedTime": "2026-10-30T00:00:00Z"}

        def _raw_doc(self, meta):
            if meta["id"] in w.unreadable:
                raise RuntimeError("permanently malformed document")
            return RawDoc(source="gdrive", external_id=meta["id"], title=meta["name"], body="body text")

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    return w


def _doc(path: str) -> str:
    return path.rsplit("/", 1)[-1].removesuffix(".md")


def _owed(state: StateStore):
    return [tuple(row) for row in state._db.execute(
        "SELECT item_key, failures, exhausted_at FROM pending_work "
        "WHERE acknowledged_at IS NULL AND superseded_at IS NULL ORDER BY item_key").fetchall()]


@pytest.mark.parametrize("mode", ["exception", "503"])
@pytest.mark.parametrize("lost_runs", [1, 6])
@pytest.mark.asyncio
async def test_a_committed_checkpoint_whose_acknowledgments_are_all_lost_charges_nothing_and_recovers(
    tmp_path, monkeypatch, mode, lost_runs,
):
    w = world(monkeypatch)
    w.armed_mode, w.lose_after_pushes = mode, 1
    state = StateStore(str(tmp_path / "sidecar.sqlite"))

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    # The brain committed the first document's checkpoint; the sidecar never saw it acknowledged.
    lost = [r for r in w.checkpoint_requests if r["progress"] == w.commits[-1]]
    assert len(lost) == MAX_ATTEMPTS  # the IDENTICAL payload, retried within the bound — then nothing
    assert w.checkpoint_requests[-MAX_ATTEMPTS:] == lost  # no different checkpoint was sent after it
    assert len({r["progress_revision"] for r in lost}) == 1
    first = _doc(w.pushes[0])
    assert summary.failed == 0
    assert summary.failure_categories.get("checkpoint_unacknowledged") == 1
    assert summary.authoritative_complete is False
    assert len(w.pushes) == 1  # no further document was started under the unknown revision
    owed = dict((item, (failures, exhausted)) for item, failures, exhausted in _owed(state))
    assert owed, "the accepted document is still owed: not acknowledged before the brain's ack"
    assert all(value == (0, None) for value in owed.values())

    # Further runs that lose every acknowledgment again: still nothing charged, nothing exhausted.
    w.lose_after_pushes = None
    for _ in range(lost_runs - 1):
        again = await run_gdrive_stream(SETTINGS, CONNECTION, StateStore(str(tmp_path / "sidecar.sqlite")))
        assert again.failed == 0
        assert all(failures == 0 and exhausted is None for _item, failures, exhausted in _owed(state))

    # Acknowledgments reach the sidecar again: the next acquisition restores the brain's progress and
    # the owed work replays to completion — no sibling stream regressed on the way.
    w.armed_mode = None
    recovered_state = StateStore(str(tmp_path / "sidecar.sqlite"))
    recovered = await run_gdrive_stream(SETTINGS, CONNECTION, recovered_state)
    assert recovered.failed == 0
    assert "checkpoint_unacknowledged" not in recovered.failure_categories
    assert _owed(recovered_state) == []
    assert {_doc(path) for path in w.pushes} >= {doc for docs in DOCS.values() for doc in docs}
    assert first in {_doc(path) for path in w.pushes[1:]}  # replayed, idempotently
    streams = w.progress.get("streams") or {}
    assert set(streams) == set(DOCS)
    state.close()
    recovered_state.close()


@pytest.mark.asyncio
async def test_a_lost_response_that_an_identical_retry_acknowledges_is_no_uncertainty(tmp_path, monkeypatch):
    """Control: the brain acknowledges an exact replay — the run simply continues."""
    w = world(monkeypatch)
    state = StateStore(str(tmp_path / "control.sqlite"))
    original = httpx.MockTransport.handle_async_request
    dropped = {"n": 0}

    async def drop_one(self, request):
        body = json.loads(request.content)
        response = await original(self, request)
        if body.get("action") == "checkpoint" and w.pushes and dropped["n"] == 0:
            dropped["n"] = 1
            raise httpx.ReadTimeout("one lost response", request=request)
        return response

    monkeypatch.setattr(httpx.MockTransport, "handle_async_request", drop_one)

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert dropped["n"] == 1
    assert "checkpoint_unacknowledged" not in summary.failure_categories
    assert summary.failed == 0 and _owed(state) == []
    assert len(w.pushes) == sum(len(docs) for docs in DOCS.values())
    state.close()


@pytest.mark.asyncio
async def test_a_superseded_execution_stays_run_terminal(tmp_path, monkeypatch):
    w = world(monkeypatch)
    state = StateStore(str(tmp_path / "terminal.sqlite"))
    import aios_ingest.gdrive_sync as sync
    original_push = sync.BrainClient.push

    async def push_then_supersede(self, item, *, execution=None):
        # The execution is superseded right after the first accepted document.
        result = await original_push(self, item, execution=execution)
        w.terminal = "stale_execution"
        return result

    monkeypatch.setattr(sync.BrainClient, "push", push_then_supersede)
    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert summary.failure_categories.get("stale_execution") == 1
    assert "checkpoint_unacknowledged" not in summary.failure_categories
    assert len(w.pushes) == 1
    assert all(failures == 0 and exhausted is None for _item, failures, exhausted in _owed(state))
    state.close()
