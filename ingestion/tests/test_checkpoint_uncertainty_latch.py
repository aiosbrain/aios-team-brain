"""The ``BrainClient`` checkpoint-revision owner latches an unknown revision (AIO-1167 R47 F3).

The client owns each execution's progress revision. When a checkpoint was SENT but no 200 came back
(all bounded responses lost, terminal 5xx, a deferral after a send, or ``stale_progress``), the brain
may hold a revision this client does not know. From then on the client refuses to send any further
checkpoint under that execution — never a changed document under a guessed revision — until a fresh
acquisition restores the brain's authority. A checkpoint that was never sent latches nothing.

This pins the client layer on its own: the coordinator also stops on the first uncertainty, which
would mask a client that kept sending.
"""

from __future__ import annotations

import json

import httpx
import pytest

from aios_ingest.brain_client import BrainClient, BrainDeferred, BrainError, GdriveExecution

INTEGRATION = "11111111-1111-1111-1111-111111111111"
OWNER = "22222222-2222-2222-2222-222222222222"


def _client(handler, clock):
    async def sleep(delay):
        clock[0] += delay

    client = BrainClient("http://brain", "aios_abc_def", "demo", sleep=sleep,
                         random_fn=lambda: 0, monotonic_fn=lambda: clock[0])
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return client


def _execution(**kwargs) -> GdriveExecution:
    return GdriveExecution(INTEGRATION, 2, 4, OWNER, "later", "scope", {}, progress_revision=9, **kwargs)


def _checkpoints(calls):
    return [c for c in calls if c.get("action") == "checkpoint"]


def _acquired(request_body):
    return httpx.Response(200, json={
        "integration_id": INTEGRATION, "generation": 2, "fence": 4, "owner": request_body["owner"],
        "lease_expires_at": "later", "scope_hash": "scope", "config": {}, "progress": {},
        "progress_revision": 10,
    })


@pytest.mark.parametrize("answer", ["transport", "503", "stale_progress"])
@pytest.mark.asyncio
async def test_a_sent_unacknowledged_checkpoint_latches_until_reacquired(answer):
    calls: list[dict] = []
    clock = [100.0]
    healthy = {"on": False}

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        calls.append(body)
        if body["action"] == "acquire":
            return _acquired(body)
        if healthy["on"]:
            return httpx.Response(200, json={"progress_revision": body["progress_revision"] + 1, "progress": {}})
        if answer == "transport":
            raise httpx.ConnectError("lost", request=request)
        if answer == "503":
            return httpx.Response(503, json={"error": {"code": "unavailable", "message": "down"}})
        return httpx.Response(409, json={"error": {"code": "stale_progress", "message": "stale"}})

    client = _client(handler, clock)
    execution = _execution()
    async with client:
        with pytest.raises(BrainError) as first:
            await client.checkpoint_gdrive_execution(execution, {"page_token": "a"})
        assert client.gdrive_progress_uncertain(execution)
        if answer == "transport":
            assert first.value.code == "checkpoint_unacknowledged"
        sent = len(_checkpoints(calls))
        assert sent >= 1

        # A DIFFERENT checkpoint under the same execution is refused without being sent.
        healthy["on"] = True
        with pytest.raises(BrainDeferred) as refused:
            await client.checkpoint_gdrive_execution(execution, {"page_token": "b"})
        assert refused.value.code == "checkpoint_unacknowledged" and refused.value.not_before is None
        assert len(_checkpoints(calls)) == sent

        # A fresh acquisition restores the authority, and checkpoints are sent again.
        reacquired = await client.acquire_gdrive_execution(INTEGRATION, OWNER)
        assert not client.gdrive_progress_uncertain(reacquired)
        ack = await client.checkpoint_gdrive_execution(reacquired, {"page_token": "c"})
        assert ack["progress_revision"] == 11
        assert _checkpoints(calls)[-1]["progress_revision"] == 10


@pytest.mark.asyncio
async def test_a_lost_response_retried_identically_and_acknowledged_latches_nothing():
    calls: list[dict] = []
    clock = [100.0]

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            raise httpx.ReadTimeout("lost", request=request)
        return httpx.Response(200, json={"progress_revision": body["progress_revision"] + 1, "progress": {}})

    client = _client(handler, clock)
    execution = _execution()
    async with client:
        ack = await client.checkpoint_gdrive_execution(execution, {"page_token": "a"})
    assert ack["progress_revision"] == 10
    assert not client.gdrive_progress_uncertain(execution)
    assert calls[0] == calls[1]  # the identical payload, under the same revision


@pytest.mark.asyncio
async def test_a_checkpoint_never_sent_latches_nothing():
    calls: list[dict] = []
    clock = [100.0]

    def handler(request: httpx.Request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"progress_revision": 10, "progress": {}})

    client = _client(handler, clock)
    execution = _execution(run_deadline=99.0)
    async with client:
        with pytest.raises(BrainDeferred) as deferred:
            await client.checkpoint_gdrive_execution(execution, {"page_token": "a"})
    assert deferred.value.code == "checkpoint_deadline" and calls == []
    assert not client.gdrive_progress_uncertain(execution)
