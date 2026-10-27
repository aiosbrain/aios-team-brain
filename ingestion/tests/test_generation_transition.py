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

from aios_ingest.gdrive_sync import run_gdrive_stream
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
    state.close()
