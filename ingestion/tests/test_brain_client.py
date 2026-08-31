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
