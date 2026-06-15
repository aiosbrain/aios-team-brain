import httpx

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
