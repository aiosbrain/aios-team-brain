import asyncio
import json

import httpx
import pytest
from pydantic import ValidationError

from aios_ingest.brain_client import BrainError, IngestResult
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.engine import GDRIVE_RUN_WORK_BUDGET, ingest_docs, run_connection
from aios_ingest.normalize import NormalizeConfig, RawDoc
from aios_ingest.state import StateStore
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


# ---------------------------------------------------------------------------------------------
# A generic source is drained to its end, a bounded chunk at a time
# ---------------------------------------------------------------------------------------------
#
# Spec. Generic sources (Notion, Confluence, …) re-enumerate from the start and keep no durable
# place to resume from. A default run therefore reads the whole source — never more than one chunk
# of it held at once — and a long source is not a failure. Only a cap the caller asks for truncates
# a run, and says so. Google Drive keeps its durable coordinator's finite work budget.


class _ReplayingSource:
    """A legacy generic source: the same full enumeration on every fetch, whatever ``since`` is."""

    def __init__(self, total, *, fail_ids=()):
        self.total, self.fail_ids = total, set(fail_ids)
        self.produced, self.since = 0, []

    def fetch(self, since=None):
        self.since.append(since)
        for index in range(1, self.total + 1):
            self.produced += 1
            yield RawDoc(source="github", external_id=f"o/r/doc-{index}.md", body=str(index))


class _Sink:
    """The brain, as the engine calls it: records each push and how far the source read ahead."""

    def __init__(self, source):
        self.source, self.pushed, self.lead = source, [], 0

    def client(self, *args, **kwargs):
        sink = self

        class Client:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass

            async def push(self, item, *, execution=None):
                sink.lead = max(sink.lead, sink.source.produced - len(sink.pushed))
                sink.pushed.append(item.path)
                if item.path in sink.source.fail_ids:
                    raise BrainError(503, "sink_unavailable", "retry")
                return IngestResult("created", "item", item.path)

        return Client()


def _generic_world(monkeypatch, total, **kwargs):
    source = _ReplayingSource(total, **kwargs)
    sink = _Sink(source)
    monkeypatch.setattr("aios_ingest.engine.build_source", lambda *_args: source)
    monkeypatch.setattr("aios_ingest.engine.BrainClient", sink.client)
    return source, sink


async def test_default_generic_run_drains_past_five_thousand_documents_without_a_budget_failure(monkeypatch):
    total = 5_001 + 31
    source, sink = _generic_world(monkeypatch, total)

    summary = await run_connection(SETTINGS, Connection("nt", "notion", options={}), queue_size=32)

    assert len(sink.pushed) == total
    assert "github/o/r/doc-5001.md" in sink.pushed and sink.pushed[-1] == f"github/o/r/doc-{total}.md"
    assert summary.created == total
    assert summary.failed == 0 and summary.failure_categories == {}
    # Bounded: the source was never more than one chunk ahead of what had been pushed.
    assert source.produced == total and sink.lead <= 32


async def test_explicit_generic_cap_still_truncates_and_reports_its_budget(monkeypatch):
    source, sink = _generic_world(monkeypatch, 11)

    summary = await run_connection(SETTINGS, Connection("nt", "notion", options={}), max_docs=10)

    assert len(sink.pushed) == 10 and summary.created == 10
    assert summary.failed == 1 and summary.failure_categories == {"run_budget_exhausted": 1}


async def test_genuine_sink_failure_is_still_counted_on_a_full_drain(monkeypatch):
    source, sink = _generic_world(monkeypatch, 40, fail_ids={"github/o/r/doc-7.md"})

    summary = await run_connection(SETTINGS, Connection("nt", "notion", options={}))

    assert len(sink.pushed) == 40
    assert summary.created == 39
    assert summary.failed == 1 and summary.failure_categories == {"sink_unavailable": 1}


@pytest.mark.parametrize("max_docs, expected", [(None, GDRIVE_RUN_WORK_BUDGET), (7, 7)])
async def test_drive_keeps_a_finite_work_budget(tmp_path, monkeypatch, max_docs, expected):
    budgets = []

    async def run_gdrive_stream(settings, conn, store, *, max_work):
        budgets.append(max_work)
        return engine_mod.IngestSummary(conn.name)

    def no_generic_source(*_args):
        raise AssertionError("Drive never takes the generic fetch path")

    monkeypatch.setattr("aios_ingest.gdrive_sync.run_gdrive_stream", run_gdrive_stream)
    monkeypatch.setattr("aios_ingest.engine.build_source", no_generic_source)
    state = StateStore(str(tmp_path / "drive-budget.sqlite"))
    kwargs = {} if max_docs is None else {"max_docs": max_docs}

    await run_connection(SETTINGS, Connection("gd", "gdrive", options={}), state=state, **kwargs)

    assert budgets == [expected]
    assert isinstance(GDRIVE_RUN_WORK_BUDGET, int) and 0 < GDRIVE_RUN_WORK_BUDGET < 10**6
    state.close()
