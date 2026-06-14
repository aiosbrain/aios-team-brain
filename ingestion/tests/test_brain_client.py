import httpx
import pytest

from aios_ingest.brain_client import BrainClient, BrainError
from aios_ingest.payload import ItemPayload

ITEM = ItemPayload.build(project="p", path="github/o/r/x.md", kind="deliverable", body="b")


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
