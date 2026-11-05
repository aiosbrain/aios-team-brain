"""A Drive run that RAISES after acquiring still names the execution it ran under (AIO-1167 R84).

Spec (Astra R84 adjudication). R83 binds a run's report to the execution that produced it, but only a
RETURNED summary carried that identity: a run that acquired and then raised (provider setup, any
coordinator error) was reported by the scheduled and manual handlers as a freshly built failure naming
no execution — indistinguishable, to the brain, from a failure before acquisition, so it could publish
failure evidence under an authority that had since been superseded. Through the REAL coordinator over
the checkpoint-acknowledgment world and the real reporting handlers and wire builders:

  * a run that raises after a real acquisition is reported — scheduled and manual — with that exact
    acquired ``{generation, fence, owner}``, its resolved integration id, and the unchanged sanitized
    ``coordinator_error`` payload (no exception text or class), after its lease was released;
  * a failure before acquisition and a busy deferral still name no execution;
  * cancellation after acquisition propagates, releases the lease and reports nothing.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from aios_ingest import brain_client as brain_client_module
from aios_ingest import gdrive_sync, scheduler
from aios_ingest.brain_client import BrainError
from aios_ingest.state import StateStore
from test_checkpoint_acknowledgment import CONNECTION, GENERATION, INTEGRATION, SETTINGS, world

LEAK = "provider-setup-secret-do-not-leak"
CLAIM = {
    "id": "11111111-1111-1111-1111-111111111111", "integration_id": INTEGRATION, "name": "docs",
    "trigger": "manual", "created_at": "now", "attempt_token": "33333333-3333-3333-3333-333333333333",
}


class _ProviderSetupFailed(RuntimeError):
    pass


def _wire(monkeypatch):
    """The scheduler's own BrainClient, real payload builders over a recording transport."""
    sent: list[dict] = []
    real = brain_client_module.BrainClient

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json={"request": CLAIM})
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True})

    class Wire(real):
        def __init__(self, *args, **kwargs):
            super().__init__("http://brain", "aios_abc_def", "demo", max_per_min=10_000)
            self._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(brain_client_module, "BrainClient", Wire)
    return sent


def _released(monkeypatch):
    """Every execution the coordinator released, as it sent them."""
    released: list[dict] = []
    client = gdrive_sync.BrainClient
    original = client.release_gdrive_execution

    async def release(self, execution):
        released.append({"generation": execution.generation, "fence": execution.fence, "owner": execution.owner})
        return await original(self, execution)

    monkeypatch.setattr(client, "release_gdrive_execution", release)
    return released


def _raise_after_acquisition(monkeypatch, error: BaseException):
    """Provider setup — after the run acquired its execution — raises ``error``."""
    base = gdrive_sync.GoogleDriveSource

    class Failing(base):
        def _services(self):
            raise error

    monkeypatch.setattr(gdrive_sync, "GoogleDriveSource", Failing)


async def _enabled_row(_settings, _conn, integration_id=None):
    return {"id": INTEGRATION, "name": "docs", "type": "gdrive", "status": "enabled"}


async def _scheduled(monkeypatch, tmp_path, name):
    monkeypatch.setattr(scheduler, "_gdrive_admin_row", _enabled_row)
    await scheduler._poll_job(SETTINGS, CONNECTION, StateStore(str(tmp_path / f"{name}.sqlite")))


async def _manual(tmp_path, name):
    await scheduler._manual_gdrive_job(SETTINGS, [], StateStore(str(tmp_path / f"{name}.sqlite")))


def _sanitized(body: dict) -> None:
    assert body["status"] == "failed" and body["error"] == "coordinator_error" and body["failed"] == 1
    assert body["authoritativeComplete"] is False
    assert LEAK not in json.dumps(body) and "_ProviderSetupFailed" not in json.dumps(body)


@pytest.mark.parametrize("handler", ["scheduled", "manual"])
@pytest.mark.asyncio
async def test_a_run_that_raises_after_acquiring_reports_that_exact_execution(tmp_path, monkeypatch, handler):
    world(monkeypatch)
    sent, released = _wire(monkeypatch), _released(monkeypatch)
    _raise_after_acquisition(monkeypatch, _ProviderSetupFailed(LEAK))

    if handler == "scheduled":
        await _scheduled(monkeypatch, tmp_path, handler)
    else:
        await _manual(tmp_path, handler)

    (acquired,) = released  # acquired, then released by the run's own cleanup before reporting
    assert acquired["generation"] == GENERATION
    (body,) = sent
    assert body["execution"] == acquired, "the exact acquired identity — never a lookup of today's"
    _sanitized(body)
    if handler == "scheduled":
        assert body["integrationId"] == INTEGRATION and body["trigger"] == "scheduler"
    else:
        assert (body["requestId"], body["attemptToken"]) == (CLAIM["id"], CLAIM["attempt_token"])


@pytest.mark.parametrize("before", ["pre-acquisition-exception", "busy-deferral"])
@pytest.mark.parametrize("handler", ["scheduled", "manual"])
@pytest.mark.asyncio
async def test_a_run_that_never_acquired_names_no_execution(tmp_path, monkeypatch, handler, before):
    world(monkeypatch)
    sent, released = _wire(monkeypatch), _released(monkeypatch)

    async def refuse(self, integration_id, owner):
        if before == "busy-deferral":
            raise BrainError(409, "execution_busy", "busy")
        raise _ProviderSetupFailed(LEAK)

    monkeypatch.setattr(gdrive_sync.BrainClient, "acquire_gdrive_execution", refuse)
    if handler == "scheduled":
        await _scheduled(monkeypatch, tmp_path, f"{handler}-{before}")
    else:
        await _manual(tmp_path, f"{handler}-{before}")

    assert released == []
    (body,) = sent
    assert "execution" not in body
    assert body["status"] == ("deferred" if before == "busy-deferral" else "failed")
    if before == "pre-acquisition-exception":
        _sanitized(body)


@pytest.mark.parametrize("handler", ["scheduled", "manual"])
@pytest.mark.asyncio
async def test_cancellation_after_acquiring_propagates_releases_and_reports_nothing(tmp_path, monkeypatch, handler):
    world(monkeypatch)
    sent, released = _wire(monkeypatch), _released(monkeypatch)
    _raise_after_acquisition(monkeypatch, asyncio.CancelledError())

    with pytest.raises(asyncio.CancelledError) as cancelled:
        if handler == "scheduled":
            await _scheduled(monkeypatch, tmp_path, handler)
        else:
            await _manual(tmp_path, handler)

    assert gdrive_sync.raised_execution(cancelled.value) is None, "cancellation is never tagged"
    assert len(released) == 1, "the run's cleanup still released its lease"
    assert sent == [], "nothing reported"
