"""A Drive run's outcome names the execution that produced it (AIO-1167 R83 F1).

Spec (Astra R83 adjudication F1). The coordinator freezes ``{generation, fence, owner}`` from THIS run's
acquisition and attaches it to the run's summary; the brain client sends it, unchanged, on both report
wires. It is never looked up when the outcome is reported. A run that acquired nothing — a busy
deferral, an acquisition refusal — names no execution, so its report is a diagnostic, never progress.
"""

from __future__ import annotations

import json

import httpx
import pytest

from aios_ingest.brain_client import BrainError, GdriveRunRequest
from aios_ingest.engine import IngestSummary
from aios_ingest.gdrive_sync import run_gdrive_stream
from aios_ingest.state import StateStore
from test_brain_client import _client
from test_checkpoint_acknowledgment import CONNECTION, GENERATION, SETTINGS, world


@pytest.mark.asyncio
async def test_each_run_freezes_the_identity_of_its_own_acquisition(tmp_path, monkeypatch):
    w = world(monkeypatch)
    state = StateStore(str(tmp_path / "identity.sqlite"))

    first = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    owner = w.checkpoint_requests[0]["owner"]
    assert first.execution == {"generation": GENERATION, "fence": w.fence, "owner": owner}

    before = len(w.checkpoint_requests)
    second = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert second.execution == {
        "generation": GENERATION, "fence": w.fence, "owner": w.checkpoint_requests[before]["owner"],
    }
    assert second.execution["fence"] == first.execution["fence"] + 1, "a new acquisition, a new fence"
    assert second.execution["owner"] != owner
    # Frozen: the first run's outcome still names ITS execution after the authority moved on.
    assert first.execution == {"generation": GENERATION, "fence": second.execution["fence"] - 1, "owner": owner}
    state.close()


@pytest.mark.parametrize("code", ["execution_busy", "connection_unavailable"])
@pytest.mark.asyncio
async def test_a_run_that_acquired_nothing_names_no_execution(tmp_path, monkeypatch, code):
    w = world(monkeypatch)

    async def refuse(self, integration_id, owner):
        raise BrainError(409, code, "refused")

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient.acquire_gdrive_execution", refuse)
    summary = await run_gdrive_stream(SETTINGS, CONNECTION, StateStore(str(tmp_path / f"{code}.sqlite")))

    assert summary.execution is None
    assert summary.failure_categories == {code: 1}
    assert w.checkpoint_requests == []


_REQUEST = GdriveRunRequest(
    "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222",
    "drive", "manual", "now", "33333333-3333-3333-3333-333333333333",
)
_EXECUTION = {"generation": 4, "fence": 9, "owner": "44444444-4444-4444-4444-444444444444"}


@pytest.mark.parametrize("execution", [_EXECUTION, None], ids=["acquired", "none"])
@pytest.mark.parametrize("wire", ["manual", "scheduled"])
@pytest.mark.asyncio
async def test_both_report_wires_carry_the_frozen_identity_or_omit_it(wire, execution):
    sent: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(json.loads(req.content))
        return httpx.Response(200, json={"ok": True})

    summary = IngestSummary("drive", unchanged=1, authoritative_complete=True, backlog=0, execution=execution)
    async with _client(httpx.MockTransport(handler)) as client:
        if wire == "manual":
            await client.complete_gdrive_run_request(_REQUEST, summary, status="complete")
        else:
            await client.report_scheduled_gdrive_run(
                "55555555-5555-5555-5555-555555555555", _REQUEST.integration_id, "2026-11-05T00:00:00+00:00",
                summary, status="complete",
            )

    (body,) = sent
    if execution is None:
        assert "execution" not in body, "omitted, never null: the run acquired nothing"
    else:
        assert body["execution"] == _EXECUTION
