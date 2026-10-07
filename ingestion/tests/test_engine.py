import asyncio
import json

import httpx
import pytest
from pydantic import ValidationError

from aios_ingest.config import BrainSettings
from aios_ingest.engine import ingest_docs
from aios_ingest.normalize import NormalizeConfig, RawDoc
import aios_ingest.engine as engine_mod
import aios_ingest.brain_client as bc_mod

SETTINGS = BrainSettings(base_url="http://brain", api_key="aios_a_b", team="demo")


def _patch_transport(monkeypatch, handler):
    """Make every BrainClient created in the engine use a mock transport."""
    orig_init = bc_mod.BrainClient.__init__

    def init(self, *a, **kw):
        orig_init(self, *a, **kw)
        self._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(bc_mod.BrainClient, "__init__", init)


async def test_ingest_docs_counts_statuses(monkeypatch):
    seen: dict[str, int] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        body = req.read().decode()
        # first time a path is seen -> created; subsequently -> unchanged
        import json

        path = json.loads(body)["path"]
        seen[path] = seen.get(path, 0) + 1
        status = "created" if seen[path] == 1 else "unchanged"
        return httpx.Response(201 if status == "created" else 200, json={"status": status, "id": path})

    _patch_transport(monkeypatch, handler)

    docs = [
        RawDoc(source="github", external_id="o/r/a.md", body="a"),
        RawDoc(source="github", external_id="o/r/b.md", body="b"),
    ]
    summary = await ingest_docs(SETTINGS, docs, NormalizeConfig(), "test")
    assert summary.created == 2
    assert summary.total == 2

    # idempotency: same docs again -> all unchanged
    summary2 = await ingest_docs(SETTINGS, docs, NormalizeConfig(), "test")
    assert summary2.unchanged == 2
    assert summary2.created == 0


# A regression here is a hang, not a wrong value: bound every run so it fails instead of stalling.
_HANG_GUARD_SECONDS = 5


async def test_normalize_validation_error_unblocks_full_queue_and_propagates(monkeypatch):
    pushed: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        pushed.append(json.loads(req.read())["path"])
        return httpx.Response(201, json={"status": "created", "id": "x"})

    _patch_transport(monkeypatch, handler)
    total = 50
    produced = 0

    def docs():
        nonlocal produced
        # The first document cannot become an ItemPayload (project is capped at 120 chars), so the
        # only worker dies in normalize() while the producer still holds 49 undelivered documents.
        yield RawDoc(source="github", external_id="o/r/bad.md", body="bad", project="p" * 121)
        produced += 1
        for index in range(1, total):
            yield RawDoc(source="github", external_id=f"o/r/{index}.md", body=str(index))
            produced += 1

    before = asyncio.all_tasks()
    with pytest.raises(ValidationError):
        await asyncio.wait_for(
            ingest_docs(SETTINGS, docs(), NormalizeConfig(), "test", max_concurrency=1, queue_size=1),
            _HANG_GUARD_SECONDS,
        )

    assert pushed == []
    # The producer was stopped on the full one-slot queue rather than left to drain the source.
    assert produced < total
    assert asyncio.all_tasks() - before == set()


async def test_uncaught_transport_error_cancels_in_flight_workers_and_propagates(monkeypatch):
    in_flight = asyncio.Event()
    cancelled: list[str] = []

    async def handler(req: httpx.Request) -> httpx.Response:
        path = json.loads(req.read())["path"]
        if path.endswith("boom.md"):
            # Fail only once the sibling worker is provably parked inside its own push.
            await in_flight.wait()
            raise httpx.ConnectError("connection refused", request=req)
        in_flight.set()
        try:
            await asyncio.Event().wait()  # never answers
        except asyncio.CancelledError:
            cancelled.append(path)
            raise

    _patch_transport(monkeypatch, handler)
    total = 50
    produced = 0

    def docs():
        nonlocal produced
        for name in ["slow", "boom", *(str(index) for index in range(2, total))]:
            yield RawDoc(source="github", external_id=f"o/r/{name}.md", body=name)
            produced += 1

    before = asyncio.all_tasks()
    with pytest.raises(httpx.ConnectError):
        await asyncio.wait_for(
            ingest_docs(SETTINGS, docs(), NormalizeConfig(), "test", max_concurrency=2, queue_size=1),
            _HANG_GUARD_SECONDS,
        )

    assert cancelled == ["github/o/r/slow.md"]
    assert produced < total
    assert asyncio.all_tasks() - before == set()
