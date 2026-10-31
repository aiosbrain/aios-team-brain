"""A stream refusal raised by the REAL read boundary (AIO-1167 R45 M8; C5 acceptance).

`test_stream_access_isolation.py` replaces the whole stream routine for the refused stream, so it
proves the coordinator's catch, not that a provider refusal read by `changes().list` reaches it. Here
the real coordinator runs the real per-stream routine over the real `GoogleDriveSource` request path
(`_execute` → `_provider_call`, which classifies Google's answer); only Google's transport is a fake.

Spec (AC-03/04/05; accepted spec "Drive acceptance tests" — denied stream, quota, terminal auth):

  * A non-quota 403 or 404 on ONE stream's change log is that stream's failure. Whichever order the
    streams run in, the denied stream keeps its cursor and its published membership, the unaffected
    stream progresses to its terminal token, the run is partial (`stream_access_denied`), and no
    complete-snapshot reconciliation — which could remove the denied stream's documents — is made.
    When the stream is readable again it recovers without having lost its membership.
  * A quota 403 (rate-limit reason) or a 429 is the ACCOUNT's wait (R45 H1): every stream is held,
    and the other stream is not read.
  * A rejected credential (Google 401) and a brain authority refusal stay RUN-terminal: no other
    stream is read after them, and neither is filed as a one-stream access refusal.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from aios_ingest.brain_client import BrainError, GdriveExecution
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.gdrive_sync import run_gdrive_stream
from aios_ingest.sources.gdrive import GoogleDriveSource
from aios_ingest.state import StateStore, StreamKey

INTEGRATION = "00000000-0000-0000-0000-0000000000c9"
GENERATION = 4
DRIVES = ("drive-a", "drive-b")
SETTINGS = BrainSettings("http://brain", "key", "team")
CONNECTION = Connection("docs", "gdrive", options={"integration_id": INTEGRATION}, project="docs")


class GoogleHttpError(Exception):
    """A Google API error as googleapiclient raises it: status on ``resp``, reasons in the body."""

    def __init__(self, status: int, reason: str | None = None):
        super().__init__(f"HTTP {status}")
        self.resp = type("Response", (), {"status": status})()
        self.content = json.dumps({"error": {
            "code": status, "errors": [{"reason": reason}] if reason else [],
        }}).encode()


def _ns(drive: str) -> str:
    return StreamKey("team", INTEGRATION, "account", drive).namespace(GENERATION)


def world(monkeypatch, refusals: dict[str, Exception]):
    """``refusals`` maps a drive to what its change log answers (until removed from the dict)."""
    w = SimpleNamespace(reads=[], reconciles=[], progress={}, revision=0, refusals=refusals)

    class Request:
        def __init__(self, drive):
            self.drive = drive

        def execute(self):
            w.reads.append(self.drive)
            error = w.refusals.get(self.drive)
            if error is not None:
                raise error
            return {"changes": [], "newStartPageToken": f"terminal:{self.drive}"}

    class Changes:
        def list(self, **kwargs):
            return Request(kwargs.get("driveId"))

    class Drive:
        def changes(self): return Changes()

    class Source(GoogleDriveSource):
        """The REAL request path and classification; only the services are fakes."""

        def __init__(self, **kwargs):
            super().__init__(shared_drive_ids=list(DRIVES), api_mode="docs", _drive_service=Drive(),
                             _docs_service=object(), provider_retry_attempts=1)

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

        async def reconcile_gdrive(self, execution, **kwargs):
            w.reconciles.append(kwargs)
            return {"items": 0}

        async def release_gdrive_execution(self, execution): pass

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    return w


def _seed(state: StateStore) -> None:
    """Both streams current with a cursor; each has published one document's membership."""
    for drive in DRIVES:
        progress = state.begin_generation(
            StreamKey("team", INTEGRATION, "account", drive), GENERATION, start_token=f"start:{drive}", phase="current",
        )
        snapshot = state.begin_selection_snapshot(progress.namespace, GENERATION, [(drive, "drive", drive, True)])
        state.complete_traversal(progress.namespace, GENERATION, drive, drive, None, snapshot_id=snapshot)
        state.record_membership(progress.namespace, GENERATION, f"doc-{drive}", drive, drive, snapshot_id=snapshot)
        state.publish_selection_snapshot(progress.namespace, GENERATION, snapshot)
        state.update_progress(progress.namespace, listing_complete=True, page_token=f"cursor:{drive}")


def _membership(state: StateStore, drive: str) -> list[str]:
    progress = state.get_progress(_ns(drive))
    return state.membership_ids(_ns(drive), GENERATION, snapshot_id=progress.active_snapshot)


def _complete_snapshot_reconciles(w) -> list[dict]:
    return [call for call in w.reconciles if call.get("complete_snapshot_ids") is not None]


@pytest.mark.parametrize("denied", DRIVES, ids=["denied-runs-first", "denied-runs-second"])
@pytest.mark.parametrize("status", [403, 404])
@pytest.mark.asyncio
async def test_a_non_quota_refusal_isolates_its_stream_in_either_rotation_and_recovers(tmp_path, monkeypatch, denied, status):
    other = next(drive for drive in DRIVES if drive != denied)
    w = world(monkeypatch, {denied: GoogleHttpError(status, "insufficientFilePermissions" if status == 403 else None)})
    state = StateStore(str(tmp_path / f"denied-{denied}-{status}.sqlite"))
    _seed(state)

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    # Both streams were read, in roster order (so `denied` ran first or second as its id says), the
    # refused one exactly once: the refusal stopped only its own stream.
    assert w.reads == list(DRIVES)
    assert w.reads.index(denied) == (0 if denied == DRIVES[0] else 1)
    assert summary.failure_categories.get("stream_access_denied") == 1
    assert "rate_limited" not in summary.failure_categories
    assert summary.authoritative_complete is False
    # The denied stream keeps its cursor and membership (a 403/404 proves nothing deleted) …
    assert state.get_progress(_ns(denied)).page_token == f"cursor:{denied}"
    assert _membership(state, denied) == [f"doc-{denied}"]
    assert state.get_progress(_ns(denied)).retry_not_before is None  # not an account hold
    # … the unaffected stream drained to its terminal token …
    assert state.get_progress(_ns(other)).page_token == f"terminal:{other}"
    assert _membership(state, other) == [f"doc-{other}"]
    # … and nothing reconciled a complete snapshot that the denied stream could not vouch for.
    assert _complete_snapshot_reconciles(w) == []

    # Readable again: the stream recovers from its own cursor, its membership intact.
    w.refusals.clear()
    recovered = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert "stream_access_denied" not in recovered.failure_categories
    assert state.get_progress(_ns(denied)).page_token == f"terminal:{denied}"
    assert _membership(state, denied) == [f"doc-{denied}"]
    for call in _complete_snapshot_reconciles(w):
        assert f"doc-{denied}" not in (call.get("removed_provider_ids") or [])
    state.close()


@pytest.mark.parametrize("refusal", [
    GoogleHttpError(403, "userRateLimitExceeded"),
    GoogleHttpError(403, "rateLimitExceeded"),
    GoogleHttpError(429),
], ids=["quota-403-user", "quota-403-project", "429"])
@pytest.mark.asyncio
async def test_a_quota_refusal_on_a_change_log_holds_the_account(tmp_path, monkeypatch, refusal):
    w = world(monkeypatch, {DRIVES[0]: refusal, DRIVES[1]: refusal})
    state = StateStore(str(tmp_path / "quota.sqlite"))
    _seed(state)

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert len(w.reads) == 1  # the first answer closed the account: the other stream was not read
    assert summary.failure_categories.get("rate_limited") == 1
    assert "stream_access_denied" not in summary.failure_categories
    holds = [state.get_progress(_ns(drive)).retry_not_before for drive in DRIVES]
    assert holds[0] is not None and holds[0] == holds[1]  # every stream of the account
    assert [state.get_progress(_ns(drive)).page_token for drive in DRIVES] == [f"cursor:{d}" for d in DRIVES]
    assert _complete_snapshot_reconciles(w) == []
    state.close()


@pytest.mark.parametrize("refusal, code", [
    (GoogleHttpError(401), "provider_unauthorized"),
    (BrainError(409, "connection_unavailable", "paused"), "connection_unavailable"),
], ids=["google-401", "brain-authority"])
@pytest.mark.asyncio
async def test_an_auth_or_authority_failure_is_run_terminal_not_a_stream_refusal(tmp_path, monkeypatch, refusal, code):
    w = world(monkeypatch, {DRIVES[0]: refusal, DRIVES[1]: refusal})
    state = StateStore(str(tmp_path / f"terminal-{code}.sqlite"))
    _seed(state)

    summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    assert len(w.reads) == 1  # no other stream is read after it
    assert summary.failure_categories.get(code) == 1
    assert "stream_access_denied" not in summary.failure_categories
    assert summary.authoritative_complete is False
    assert [state.get_progress(_ns(drive)).page_token for drive in DRIVES] == [f"cursor:{d}" for d in DRIVES]
    assert [state.get_progress(_ns(drive)).retry_not_before for drive in DRIVES] == [None, None]
    assert _complete_snapshot_reconciles(w) == []
    state.close()
