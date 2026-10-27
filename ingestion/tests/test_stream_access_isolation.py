"""One started stream's provider refusal does not abort the others (AIO-1167 R44 C5).

Spec (AC-03/04/07). Two already-started streams; one returns a non-quota 403/404 from Google.
In BOTH rotation orders the healthy stream still runs and commits, the refused stream keeps its
cursor and is recorded durably as `stream_access_denied`, the run reports the failure, and no
complete snapshot is submitted (its membership is not known now — a 403/404 proves nothing
deleted). When access returns, the next run retries safely and completes. Brain authority errors
and other exceptions keep their run-terminal handling.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aios_ingest import gdrive_sync
from aios_ingest.gdrive_sync import _stream_access_refusal, run_gdrive_stream
from aios_ingest.brain_client import BrainError
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import StateStore, StreamKey
from test_gdrive_cursor_age import CONNECTION, INTEGRATION, SETTINGS, clock, world_for  # noqa: F401


class _Refused(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.resp = SimpleNamespace(status=status)


@pytest.mark.parametrize("exc, isolated", [
    (_Refused(403), True), (_Refused(404), True), (_Refused(500), False), (RuntimeError("bug"), False),
    (BrainError(403, "wrong_connection", "no"), False), (ProviderDeferred("later", category="rate_limited"), False),
])
def test_only_a_provider_403_or_404_is_a_stream_refusal(exc, isolated):
    assert _stream_access_refusal(exc) is isolated


@pytest.mark.asyncio
async def test_a_refused_stream_is_isolated_in_both_rotation_orders(tmp_path, monkeypatch, clock):  # noqa: F811
    world = world_for(monkeypatch)
    state = StateStore(str(tmp_path / "isolation.sqlite"))
    assert (await run_gdrive_stream(SETTINGS, CONNECTION, state)).authoritative_complete is True
    reconciles = world.reconciles
    healthy = gdrive_sync._run_gdrive_stream_unlocked
    attempted: list[str] = []
    refused = {"drive-b"}

    async def stream_run(settings, conn, state, **kwargs):
        attempted.append(kwargs["drive_id"])
        if kwargs["drive_id"] in refused:
            raise _Refused(403)
        return await healthy(settings, conn, state, **kwargs)

    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", stream_run)
    orders = []
    for _ in range(2):
        attempted.clear()
        clock.advance(60)
        summary = await run_gdrive_stream(SETTINGS, CONNECTION, state)
        orders.append(list(attempted))
        assert set(attempted) == {"drive-a", "drive-b"}  # the healthy stream always ran
        assert summary.failure_categories.get("stream_access_denied") == 1
        assert summary.failed >= 1 and summary.authoritative_complete is False
        assert world.reconciles == reconciles  # no absence from an unknown membership
        refused_progress = state.get_progress(StreamKey("team", INTEGRATION, "account", "drive-b").namespace(6))
        assert refused_progress.last_error == "stream_access_denied"
        assert refused_progress.page_token == "terminal"  # the cursor is kept
    assert orders[0] != orders[1]  # both rotation orders were exercised

    refused.clear()  # access returns
    clock.advance(60)
    recovered = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    assert recovered.authoritative_complete is True and world.reconciles == reconciles + 1
    state.close()


@pytest.mark.asyncio
async def test_any_other_stream_exception_is_still_run_terminal(tmp_path, monkeypatch, clock):  # noqa: F811
    world_for(monkeypatch)
    state = StateStore(str(tmp_path / "terminal.sqlite"))

    async def stream_run(settings, conn, state, **kwargs):
        raise RuntimeError("an unexpected bug")

    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", stream_run)
    with pytest.raises(RuntimeError, match="unexpected bug"):
        await run_gdrive_stream(SETTINGS, CONNECTION, state)
    state.close()
