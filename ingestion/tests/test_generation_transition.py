"""Local state across an A → B → A scope transition (AIO-1167 R44 T3).

Spec (accepted spec, local cursor/queue behaviour). Selection A runs under generation 6; the Admin
changes it to B (generation 7); then back to A — and the brain issues a NEW generation (8), never 6
again. The sidecar must treat generation 8 as a fresh stream namespace: generation 6's cursor is not
restored into it, generation 6's queued obligations are not drained or acknowledged by it, and a
notification hint recorded before the return wakes the stream without reviving old work. The old
generation's state is retained untouched (diagnosis), and only the brain's fence decides authority —
the existing brain HTTP A→B→A test covers that side.
"""

from __future__ import annotations

import pytest

from aios_ingest.brain_client import GdriveExecution
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.gdrive_sync import _run_gdrive_stream_unlocked, run_gdrive_stream
from aios_ingest.state import StateStore, StreamKey
from test_gdrive_cursor_age import CONNECTION, INTEGRATION, SETTINGS, clock, world_for  # noqa: F401


def _key(drive: str) -> StreamKey:
    return StreamKey("team", INTEGRATION, "account", drive)


@pytest.mark.asyncio
async def test_returning_to_selection_a_starts_a_fresh_generation_and_revives_nothing(tmp_path, monkeypatch, clock):  # noqa: F811
    world = world_for(monkeypatch, generation=6, drives=("drive-a", "drive-b"))
    state = StateStore(str(tmp_path / "a-b-a.sqlite"))

    # Selection A, generation 6: completes, then an obligation is left queued under it.
    assert (await run_gdrive_stream(SETTINGS, CONNECTION, state)).authoritative_complete is True
    old_ns = _key("drive-a").namespace(6)
    state.enqueue_work(old_ns, 6, "old-doc", "upsert", {"page": "old"})
    old_progress = state.get_progress(old_ns)
    assert old_progress.page_token == "terminal"

    # Selection B, generation 7: a different drive.
    clock.advance(60)
    world.generation, world.drives = 7, ["drive-c"]
    await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert state.get_progress(_key("drive-c").namespace(7)) is not None

    # A notification for drive-a arrives before the return.
    state.record_stream_hint(_key("drive-a"))
    assert state.pending_stream_hint(_key("drive-a")) is not None

    # Back to selection A: the brain issues generation 8.
    clock.advance(60)
    world.generation, world.drives = 8, ["drive-a", "drive-b"]
    returned = await run_gdrive_stream(SETTINGS, CONNECTION, state)

    new_ns = _key("drive-a").namespace(8)
    assert new_ns != old_ns
    fresh = state.get_progress(new_ns)
    # A fresh baseline for generation 8 — never generation 6's cursor.
    assert fresh is not None and fresh.baseline_start_token == "start:drive-a"
    assert state.pending_count(new_ns, 8) == 0
    assert [w.item_key for w in state.list_pending(new_ns, 8)] == []
    # Generation 6's queue and cursor are untouched: neither drained nor acknowledged under 8.
    assert [w.item_key for w in state.list_pending(old_ns, 6)] == ["old-doc"]
    retained = state.get_progress(old_ns)
    assert (retained.page_token, retained.last_success_at) == (old_progress.page_token, old_progress.last_success_at)
    # The generation-8 run is judged on generation 8 alone.
    assert returned.authoritative_complete is True
    # The pre-return notification is a per-STREAM wake-up, not generation-scoped work: it survives
    # the A→B→A transition as a pending wake-up for drive-a (which is now generation 8's stream) and
    # has not been turned into any obligation — under generation 6 or 8. This harness replaces the
    # per-stream drain (`world_for` stubs `_run_gdrive_stream_unlocked`), and acknowledging a hint
    # happens only inside that real drain, so its consumption by generation 8 is proven by the
    # real-drain regression below, not here.
    assert state.pending_stream_hint(_key("drive-a")) is not None
    assert INTEGRATION in state.pending_hint_connections("team")
    assert [w.item_key for w in state.list_pending(old_ns, 6)] == ["old-doc"]
    assert state.pending_count(new_ns, 8) == 0
    state.close()


# ── the REAL per-stream drain ────────────────────────────────────────────────────────────────────
#
# Spec (T3, hint half). A notification for drive-a recorded before the return to selection A is a
# wake-up for drive-a's CURRENT stream: generation 8's real drain observes it before its first change
# page and, having drained to the terminal token from generation 8's OWN cursor, acknowledges exactly
# that notification. Generation 6's queue and cursor are neither read nor touched. Controls: a
# notification that arrives DURING the drain is not acknowledged by it, and a drain that stops before
# the terminal token acknowledges nothing.

_TEAM, _CONN, _ACCOUNT = "team", "connection", "account"
_OPTIONS = {"credential_identity": _ACCOUNT, "selection_state": "selected", "shared_drive_ids": ["drive-a"]}


class _Request:
    def __init__(self, value):
        self.value = value

    def execute(self):
        return self.value


class _Changes:
    """One change page per call, recording the cursor each read was made from."""

    def __init__(self, pages, during_read=None):
        self.pages, self.during_read, self.tokens = list(pages), during_read, []

    def list(self, **kwargs):
        self.tokens.append(kwargs.get("pageToken"))
        if self.during_read:
            self.during_read()
        return _Request(self.pages.pop(0))


class _DriveService:
    def __init__(self, changes):
        self.api = changes

    def changes(self):
        return self.api


class _Source:
    def _execute(self, request):
        return request.execute()


class _Client:
    revision = 0

    async def checkpoint_gdrive_execution(self, execution, payload):
        self.revision += 1
        return {"progress_revision": self.revision, "progress": payload}


def _drive_stream(state, drive, generation, cursor):
    """A started, published, listing-complete stream of ``drive`` under ``generation``."""
    key = StreamKey(_TEAM, _CONN, _ACCOUNT, drive)
    progress = state.begin_generation(key, generation, start_token=f"start-{generation}", phase="current")
    snapshot = state.begin_selection_snapshot(progress.namespace, generation, [(drive, "drive", drive, True)])
    state.complete_traversal(progress.namespace, generation, drive, drive, None, snapshot_id=snapshot)
    state.publish_selection_snapshot(progress.namespace, generation, snapshot)
    state.update_progress(progress.namespace, listing_complete=True, page_token=cursor)
    return key, progress.namespace


def _a_b_a(state):
    """Selection A (gen 6, with owed work), selection B (gen 7), then the hint, then A again (gen 8)."""
    key_a, ns6 = _drive_stream(state, "drive-a", 6, "cursor-6")
    state.enqueue_work(ns6, 6, "old-doc", "upsert", {"page": "old"})
    _drive_stream(state, "drive-c", 7, "cursor-7")
    observed = state.record_stream_hint(key_a)
    _key8, ns8 = _drive_stream(state, "drive-a", 8, "cursor-8")
    return key_a, ns6, ns8, observed


async def _drain_generation_8(state, ns8, changes, *, discovery_budget=5):
    return await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", _TEAM), Connection("docs", "gdrive"), state,
        client=_Client(), execution=GdriveExecution(_CONN, 8, 1, "owner", "later", "scope", {}),
        options=dict(_OPTIONS), source=_Source(), drive=_DriveService(changes), generation=8,
        drive_id="drive-a", namespace=ns8, max_work=10, discovery_budget=discovery_budget, retry_budget=0,
    )


def _generation_6_untouched(state, ns6):
    assert [w.item_key for w in state.list_pending(ns6, 6)] == ["old-doc"]
    retained = state.get_progress(ns6)
    assert (retained.page_token, retained.baseline_start_token) == ("cursor-6", "start-6")


TERMINAL = {"changes": [], "newStartPageToken": "terminal-8"}


@pytest.mark.asyncio
async def test_the_real_generation_8_drain_consumes_the_pre_return_hint_and_leaves_generation_6_alone(tmp_path):
    state = StateStore(str(tmp_path / "real-drain.sqlite"))
    key_a, ns6, ns8, observed = _a_b_a(state)
    assert state.pending_stream_hint(key_a) == observed  # pending before the return's drain

    changes = _Changes([TERMINAL])
    summary = await _drain_generation_8(state, ns8, changes)

    assert summary.failed == 0
    assert changes.tokens == ["cursor-8"]  # drained from generation 8's own cursor, never 6's
    assert state.pending_stream_hint(key_a) is None  # the pre-return notification was consumed
    assert state.pending_count(ns8, 8) == 0
    _generation_6_untouched(state, ns6)
    state.close()


@pytest.mark.asyncio
async def test_a_notification_arriving_during_the_generation_8_drain_stays_pending(tmp_path):
    state = StateStore(str(tmp_path / "real-drain-concurrent.sqlite"))
    key_a, ns6, ns8, observed = _a_b_a(state)
    arrivals = []
    changes = _Changes([TERMINAL], during_read=lambda: arrivals.append(state.record_stream_hint(key_a)))

    await _drain_generation_8(state, ns8, changes)

    (later,) = arrivals
    assert later > observed
    assert state.pending_stream_hint(key_a) == later  # only what the drain observed was acknowledged
    _generation_6_untouched(state, ns6)
    state.close()


@pytest.mark.asyncio
async def test_a_generation_8_drain_that_stops_before_the_terminal_token_acknowledges_nothing(tmp_path):
    state = StateStore(str(tmp_path / "real-drain-partial.sqlite"))
    key_a, ns6, ns8, observed = _a_b_a(state)
    changes = _Changes([{"changes": [], "nextPageToken": "cursor-8b"}])

    await _drain_generation_8(state, ns8, changes, discovery_budget=1)

    assert changes.tokens == ["cursor-8"]
    assert state.pending_stream_hint(key_a) == observed
    _generation_6_untouched(state, ns6)
    state.close()
