import json

import httpx
import pytest

from aios_ingest.brain_client import BrainClient, BrainError, GdriveExecution, GdriveRunRequest
from aios_ingest.engine import IngestSummary
from aios_ingest.payload import ItemPayload

ITEM = ItemPayload.build(project="p", path="github/o/r/x.md", kind="deliverable", body="b")


async def test_gdrive_completion_omits_absent_error_and_reports_explicit_outcome():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(json.loads(req.content))
        return httpx.Response(200, json={"ok": True})

    summary = IngestSummary(
        "drive", unchanged=2, skipped=1, authoritative_complete=True,
        backlog=0, cursor_age_seconds=12.5,
    )
    request = GdriveRunRequest(
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222", "drive", "manual", "now",
    )
    async with _client(httpx.MockTransport(handler)) as client:
        await client.complete_gdrive_run_request(request, summary, status="complete")

    assert "error" not in seen
    assert seen == {
        "requestId": request.id, "status": "complete", "created": 0, "updated": 0,
        "unchanged": 2, "removed": 0, "failed": 0, "skipped": 1,
        "backlog": 0, "cursorAgeSeconds": 12.5, "authoritativeComplete": True,
    }


def _client(transport: httpx.MockTransport) -> BrainClient:
    c = BrainClient("http://brain", "aios_abc_def", "demo", max_per_min=10_000)
    c._client = httpx.AsyncClient(transport=transport)  # inject mock transport
    return c


async def test_push_created_returns_status_and_id():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.headers["authorization"] == "Bearer aios_abc_def"
        assert req.headers["x-aios-team"] == "demo"
        return httpx.Response(201, json={"status": "created", "id": "item-1"})

    async with _client(httpx.MockTransport(handler)) as c:
        result = await c.push(ITEM)
    assert result.status == "created"
    assert result.id == "item-1"


async def test_push_retries_on_429_then_succeeds():
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"retry-after": "0"}, json={"error": {}})
        return httpx.Response(200, json={"status": "unchanged", "id": "item-2"})

    async with _client(httpx.MockTransport(handler)) as c:
        result = await c.push(ITEM)
    assert calls["n"] == 2
    assert result.status == "unchanged"


async def test_push_raises_brainerror_on_422():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"error": {"code": "forbidden_tier", "message": "nope"}})

    async with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(BrainError) as ei:
            await c.push(ITEM)
    assert ei.value.status_code == 422
    assert ei.value.code == "forbidden_tier"


def test_rejects_non_aios_key():
    with pytest.raises(ValueError):
        BrainClient("http://brain", "badkey", "demo")


async def test_fetch_integration_selections_parses_list_and_sends_auth():
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.method == "GET"
        assert req.url.path == "/api/v1/integrations"
        assert req.headers["authorization"] == "Bearer aios_abc_def"
        assert req.headers["x-aios-team"] == "demo"
        return httpx.Response(
            200,
            json={
                "integrations": [
                    {
                        "id": "i1",
                        "type": "slack",
                        "name": "eng-slack",
                        "config": {"channelIds": ["C1"]},
                        "status": "enabled",
                    }
                ]
            },
        )

    async with _client(httpx.MockTransport(handler)) as c:
        sels = await c.fetch_integration_selections()
    assert len(sels) == 1
    assert sels[0]["type"] == "slack"
    assert sels[0]["config"]["channelIds"] == ["C1"]


async def test_fetch_integration_selections_returns_empty_on_404():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"code": "not_found", "message": "no route"}})

    async with _client(httpx.MockTransport(handler)) as c:
        sels = await c.fetch_integration_selections()
    assert sels == []


async def test_fetch_integration_selections_raises_on_definitive_4xx():
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"code": "forbidden", "message": "nope"}})

    async with _client(httpx.MockTransport(handler)) as c:
        with pytest.raises(BrainError) as ei:
            await c.fetch_integration_selections()
    assert ei.value.status_code == 403


@pytest.mark.asyncio
async def test_gdrive_execution_then_broker_never_sends_or_persists_refresh_secret():
    seen = []

    def handler(request: httpx.Request):
        seen.append((request.url.path, request.content.decode()))
        if request.url.path.endswith("/execution"):
            return httpx.Response(200, json={
                "integration_id": "11111111-1111-1111-1111-111111111111",
                "generation": 7, "fence": 3,
                "owner": "22222222-2222-2222-2222-222222222222",
                "lease_expires_at": "2099-01-01T00:00:00Z", "scope_hash": "scope",
                "config": {"authMode": "oauth", "fileIds": ["DocA"]},
            })
        return httpx.Response(200, json={
            "access_token": "short-lived-access", "expires_at": "2099-01-01T00:00:00Z",
            "scopes": ["drive.file"],
            "account": {"subject": "subject:123", "email": "docs@example.com"},
        }, headers={"cache-control": "no-store"})

    async with _client(httpx.MockTransport(handler)) as c:
        execution = await c.acquire_gdrive_execution(
            "11111111-1111-1111-1111-111111111111",
            "22222222-2222-2222-2222-222222222222",
        )
        grant = await c.broker_gdrive_access_token(execution)
    assert grant["access_token"] == "short-lived-access"
    assert all("refresh" not in body and "client_secret" not in body for _, body in seen)


def test_gdrive_provider_gate_sends_complete_fence_and_fails_closed():
    execution = GdriveExecution(
        "11111111-1111-1111-1111-111111111111", 7, 3,
        "22222222-2222-2222-2222-222222222222", "later", "scope", {},
    )
    client = BrainClient("http://brain", "aios_abc_def", "demo")
    gate = client.gdrive_provider_gate(execution)
    seen = []

    def handler(request: httpx.Request):
        seen.append(request)
        return httpx.Response(409, json={
            "error": {"code": "stale_execution", "message": "replaced"},
        })

    gate._client.close()
    gate._client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(BrainError) as exc:
        gate()
    assert exc.value.code == "stale_execution"
    payload = json.loads(seen[0].content)
    assert payload == {
        "action": "authorize_provider",
        "integration_id": execution.integration_id,
        "generation": 7,
        "fence": 3,
        "owner": execution.owner,
    }
    assert seen[0].headers["authorization"] == "Bearer aios_abc_def"
    gate.close()


@pytest.mark.asyncio
async def test_gdrive_checkpoint_retries_429_with_revision_stable_and_retry_after():
    calls = []
    sleeps = []
    clock = [100.0]

    async def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay

    def handler(request: httpx.Request):
        payload = json.loads(request.content)
        calls.append(payload)
        if len(calls) == 1:
            return httpx.Response(429, headers={"retry-after": "3"}, json={
                "error": {"code": "rate_limited", "message": "wait"},
            })
        return httpx.Response(200, json={
            "progress_revision": payload["progress_revision"] + 1,
            "progress": payload["progress"],
        })

    client = BrainClient(
        "http://brain", "aios_abc_def", "demo", sleep=sleep,
        random_fn=lambda: 0, monotonic_fn=lambda: clock[0],
    )
    await client._client.aclose()
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    execution = GdriveExecution(
        "11111111-1111-1111-1111-111111111111", 2, 4,
        "22222222-2222-2222-2222-222222222222", "later", "scope", {},
        progress_revision=9,
    )
    async with client:
        first = await client.checkpoint_gdrive_execution(execution, {"page_token": "next"})
        await client.checkpoint_gdrive_execution(execution, {"page_token": "terminal"})

    assert first["progress_revision"] == 10
    assert [call["progress_revision"] for call in calls] == [9, 9, 10]
    assert sleeps == [3.0]


@pytest.mark.asyncio
async def test_gdrive_checkpoint_retry_is_bounded_by_deadline():
    calls = 0
    sleeps = []
    clock = [100.0]

    async def sleep(delay):
        sleeps.append(delay)
        clock[0] += delay

    def handler(_request: httpx.Request):
        nonlocal calls
        calls += 1
        return httpx.Response(503, headers={"retry-after": "60"}, json={
            "error": {"code": "unavailable", "message": "down"},
        })

    client = BrainClient(
        "http://brain", "aios_abc_def", "demo", sleep=sleep,
        random_fn=lambda: 0, monotonic_fn=lambda: clock[0],
    )
    await client._client.aclose()
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    execution = GdriveExecution(
        "11111111-1111-1111-1111-111111111111", 2, 4,
        "22222222-2222-2222-2222-222222222222", "later", "scope", {},
    )
    async with client:
        with pytest.raises(BrainError) as exc:
            await client.checkpoint_gdrive_execution(execution, {"page_token": "next"})

    assert exc.value.code == "unavailable"
    assert calls == 1
    assert sleeps == [45.0]


def _scan_client(
    transport: httpx.MockTransport,
    sleeps: list[float],
    *,
    random_value: float = 0.0,
) -> BrainClient:
    async def sleep(delay: float) -> None:
        sleeps.append(delay)

    c = BrainClient(
        "http://brain",
        "aios_abc_def",
        "demo",
        max_per_min=10_000,
        sleep=sleep,
        random_fn=lambda: random_value,
    )
    c._client = httpx.AsyncClient(transport=transport)
    return c


async def test_codebase_scan_honors_valid_retry_after_then_succeeds():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(
                429,
                headers={"retry-after": "17"},
                json={"error": {"code": "rate_limited", "message": "wait"}},
            )
        return httpx.Response(201, json={"status": "ok"})

    async with _scan_client(httpx.MockTransport(handler), sleeps, random_value=0.25) as c:
        result = await c.push_codebase_scan({"scan": "payload"})

    assert result == {"status": "ok"}
    assert calls == 2
    assert sleeps == [17.25]


@pytest.mark.parametrize(
    "retry_after",
    [None, "", "garbage", "-1", "0", "1.5", "NaN", "61", "600000"],
)
async def test_codebase_scan_invalid_or_missing_retry_after_uses_conservative_fallback(retry_after):
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls <= 5:
            headers = {} if retry_after is None else {"retry-after": retry_after}
            return httpx.Response(
                429,
                headers=headers,
                json={"error": {"code": "rate_limited", "message": "wait"}},
            )
        return httpx.Response(201, json={"status": "ok"})

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        result = await c.push_codebase_scan({"scan": "payload"})

    assert result == {"status": "ok"}
    assert calls == 6
    assert sleeps == [2, 4, 8, 16, 32]
    assert sum(sleeps) > 60


async def test_codebase_scan_adds_at_most_one_second_of_jitter_per_wait():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls <= 2:
            return httpx.Response(429, json={"error": {"code": "rate_limited", "message": "wait"}})
        return httpx.Response(201, json={"status": "ok"})

    async with _scan_client(httpx.MockTransport(handler), sleeps, random_value=1.0) as c:
        await c.push_codebase_scan({"scan": "payload"})

    assert sleeps == [3, 5]


async def test_codebase_scan_persistent_429_caps_at_six_attempts_without_terminal_sleep():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            429,
            headers={"retry-after": "7"},
            json={"error": {"code": "rate_limited", "message": "still limited"}},
        )

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        with pytest.raises(BrainError) as exc:
            await c.push_codebase_scan({"scan": "payload"})

    assert calls == 6
    assert sleeps == [7, 7, 7, 7, 7]
    assert exc.value.status_code == 429
    assert exc.value.code == "rate_limited"
    assert "still limited" in str(exc.value)


async def test_codebase_scan_terminal_5xx_keeps_actual_final_error_class():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            503,
            json={"error": {"code": "upstream_unavailable", "message": "brain unavailable"}},
        )

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        with pytest.raises(BrainError) as exc:
            await c.push_codebase_scan({"scan": "payload"})

    assert calls == 6
    assert sleeps == [2, 4, 8, 16, 32]
    assert exc.value.status_code == 503
    assert exc.value.code == "upstream_unavailable"


async def test_codebase_scan_non_429_4xx_is_immediate_and_never_sleeps():
    calls = 0
    sleeps: list[float] = []

    def handler(req: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            422,
            json={"error": {"code": "invalid_payload", "message": "bad scan"}},
        )

    async with _scan_client(httpx.MockTransport(handler), sleeps) as c:
        with pytest.raises(BrainError) as exc:
            await c.push_codebase_scan({"scan": "payload"})

    assert calls == 1
    assert sleeps == []
    assert exc.value.status_code == 422
    assert exc.value.code == "invalid_payload"
