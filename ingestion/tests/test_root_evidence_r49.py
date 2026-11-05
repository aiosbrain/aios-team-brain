"""Root evidence on the change-page path, and verified file-root restoration (AIO-1167 R49 F2/F3).

Spec (Astra R48 adjudication F2/F3/F6; AC-05/07). Through the real coordinator over ``_DriveWorld``,
with every provider deferral produced by the REAL provider-call owner:

F2 — when a change page reads a bound root (``absence_withheld``):
  * only a root read present where it is bound is settled; a duplicate tombstone for a root already
    recorded unavailable keeps that detail, locally and in the published evidence;
  * a malformed or unrepresentable Retry-After on that read keeps its diagnostic;
  * a quota answer (429, or 403 naming a rate-limit reason) is the ACCOUNT's: no further call is made
    for the account — not even a sibling stream's — the page stays unresolved and nothing is
    removed; a non-quota answer stays this stream's, and the sibling stream still runs.

F3 — a restored selected file root clears its stale "unavailable" detail only when fresh metadata in
the bound drive and ACCEPTED ingestion of the same stable id prove it; a change-log hint, a changed
drive, failed access, superseded work or failed extraction never does.
"""

from __future__ import annotations

import pytest

from aios_ingest.sources.gdrive import GoogleDriveSource, ProviderCursorInvalid, ProviderDeferred
from aios_ingest.state import StateStore
from test_bound_root_loss import DETAIL, _binding, _delete_folder_r, _folder_world, _remote_root
from test_gdrive_upgrade import _DriveWorld, _ProviderHttpError

GEN = 9


def real_deferral(status: int, retry_after: str | None = None, reason: str | None = None) -> ProviderDeferred:
    """The REAL provider-call owner's ProviderDeferred for one HTTP answer."""

    class Response:
        def __init__(self):
            self.status = status
            self.headers = {"Retry-After": retry_after} if retry_after is not None else {}

    class GoogleHttpError(Exception):
        resp = Response()
        error_details = [{"reason": reason}] if reason else []

    def request():
        raise GoogleHttpError(f"HTTP {status}")

    source = GoogleDriveSource(
        file_ids=["any"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1, provider_retry_attempts=1,
    )
    with pytest.raises(ProviderDeferred) as raised:
        source._provider_call(request)
    return raised.value


async def _lose_folder_r(world, state):
    """Baseline, then folder-r is hard-deleted and recorded unavailable (D1)."""
    assert (await world.run(state)).authoritative_complete is True
    _delete_folder_r(world)
    await world.run(state)
    assert (await world.run(state)).authoritative_complete is True
    assert DETAIL in (_binding(state, world, "folder", "folder-r").detail or "")


@pytest.mark.asyncio
async def test_a_duplicate_tombstone_keeps_the_unavailable_detail(tmp_path, monkeypatch):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / "dup.sqlite"))
    await _lose_folder_r(world, state)
    removed_before = list(world.removed)

    world.logs["shared-a"].append({"fileId": "folder-r", "removed": True})
    world.calls.clear()
    await world.run(state)

    assert ("metadata", "folder-r") in world.calls  # the change page really read the root
    assert DETAIL in (_binding(state, world, "folder", "folder-r").detail or "")
    assert DETAIL in (_remote_root(world, "folder", "folder-r")["detail"] or "")
    assert "doc-1" not in world.removed and "doc-k" not in world.removed
    assert world.removed[: len(removed_before)] == removed_before
    state.close()


@pytest.mark.parametrize("header, diagnostic", [
    ("soon", "retry_after_malformed"), ("9" * 30, "retry_after_unrepresentable"),
])
@pytest.mark.asyncio
async def test_a_root_read_deferral_on_the_change_page_keeps_its_retry_after_diagnostic(
    tmp_path, monkeypatch, header, diagnostic,
):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / "diag.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    reconciled = list(world.reconciled)

    world.files.pop("doc-2")
    world.logs["shared-a"].append({"fileId": "doc-2", "removed": True})
    world.unreadable["folder-r"] = real_deferral(503, header)
    summary = await world.run(state)

    assert summary.failure_categories.get(diagnostic) == 1
    assert summary.failure_categories.get("provider_unavailable") == 1
    assert world.removed == [] and world.reconciled == reconciled
    state.close()


def _two_stream_world(monkeypatch):
    world = _DriveWorld(folder_ids=["folder-r", "folder-s"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("doc-2", drive="shared-a", parent="folder-r")
    world.put("folder-s", drive="shared-b", folder=True)
    world.put("doc-s", drive="shared-b", parent="folder-s")
    return world


def _shared_a_first(state, world):
    state._db.execute(
        "UPDATE connection_stream_schedule SET next_drive_id='shared-a' WHERE connection_id=? AND generation=?",
        (world.integration_id, GEN),
    )
    state._db.commit()


@pytest.mark.parametrize("deferral", [
    lambda: real_deferral(429, "120"),
    lambda: real_deferral(403, "120", reason="userRateLimitExceeded"),
], ids=["429", "403-rate-limit"])
@pytest.mark.asyncio
async def test_a_quota_answer_on_the_root_read_holds_the_account_and_stops_the_sibling_stream(
    tmp_path, monkeypatch, deferral,
):
    world = _two_stream_world(monkeypatch)
    state = StateStore(str(tmp_path / "quota.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    cursor = state.get_progress(world.namespace("shared-a")).page_token

    world.files.pop("doc-2")
    world.logs["shared-a"].append({"fileId": "doc-2", "removed": True})
    world.unreadable["folder-r"] = deferral()
    _shared_a_first(state, world)
    world.calls.clear()
    summary = await world.run(state)

    assert summary.failure_categories.get("rate_limited") == 1
    root_read = world.calls.index(("metadata", "folder-r"))
    assert world.calls[root_read + 1:] == []  # no further account call, the sibling included
    assert not any(call[:2] == ("changes", "shared-b") for call in world.calls)
    assert state.connection_hold(world.integration_id, GEN, "account") is not None
    assert world.removed == []
    assert state.get_progress(world.namespace("shared-a")).page_token == cursor  # page unresolved
    state.close()


@pytest.mark.asyncio
async def test_a_non_quota_answer_on_the_root_read_stays_this_streams(tmp_path, monkeypatch):
    world = _two_stream_world(monkeypatch)
    state = StateStore(str(tmp_path / "nonquota.sqlite"))
    assert (await world.run(state)).authoritative_complete is True

    world.files.pop("doc-2")
    world.logs["shared-a"].append({"fileId": "doc-2", "removed": True})
    world.unreadable["folder-r"] = real_deferral(503)
    _shared_a_first(state, world)
    world.calls.clear()
    summary = await world.run(state)

    assert "rate_limited" not in summary.failure_categories
    assert summary.failure_categories.get("provider_unavailable") == 1
    root_read = world.calls.index(("metadata", "folder-r"))
    assert any(call[:2] == ("changes", "shared-b") for call in world.calls[root_read + 1:])
    assert state.connection_hold(world.integration_id, GEN, "account") is None
    assert world.removed == []
    state.close()


async def _lose_file_x(world, state):
    """Baseline, then file-x is lost and recorded unavailable through a 410 rescan (D1)."""
    assert (await world.run(state)).authoritative_complete is True
    world.files.pop("file-x")
    world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
    await world.run(state)
    world.cursor_errors.clear()
    assert (await world.run(state)).authoritative_complete is True
    assert DETAIL in (_binding(state, world, "file", "file-x").detail or "")


def _file_world(monkeypatch):
    world = _DriveWorld(file_ids=["file-x", "file-y"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("file-y", drive="shared-a")
    return world


@pytest.mark.asyncio
async def test_a_restored_file_root_clears_its_detail_after_accepted_ingestion(tmp_path, monkeypatch):
    world = _file_world(monkeypatch)
    state = StateStore(str(tmp_path / "restore.sqlite"))
    await _lose_file_x(world, state)

    world.put("file-x", drive="shared-a")
    world.logs["shared-a"].append({"fileId": "file-x", "file": dict(world.files["file-x"])})
    world.pushed.clear()
    restored = await world.run(state)

    assert "file-x" in world.pushed  # the same stable id, re-ingested
    binding = _binding(state, world, "file", "file-x")
    assert binding.status == "bound" and not binding.detail
    assert not _remote_root(world, "file", "file-x")["detail"]  # published under the fence
    assert "file-x" in state.membership_ids(world.namespace("shared-a"), GEN)
    assert "provider_read" not in restored.failure_categories
    state.close()


@pytest.mark.parametrize("case", ["stale_hint", "changed_drive", "failed_access", "failed_extraction"])
@pytest.mark.asyncio
async def test_a_hint_without_verified_accepted_ingestion_never_clears_the_detail(tmp_path, monkeypatch, case):
    world = _file_world(monkeypatch)
    state = StateStore(str(tmp_path / f"neg-{case}.sqlite"))
    await _lose_file_x(world, state)

    hint = {"id": "file-x", "name": "file-x", "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-09-22T00:00:00Z", "parents": ["shared-a"], "driveId": "shared-a"}
    if case == "changed_drive":
        world.put("file-x", drive="shared-b")
        hint = dict(world.files["file-x"])
    elif case != "stale_hint":
        world.put("file-x", drive="shared-a")
        hint = dict(world.files["file-x"])
    if case == "failed_access":
        world.unreadable["file-x"] = _ProviderHttpError(403)
    if case == "failed_extraction":
        world.malformed.add("file-x")
    world.logs["shared-a"].append({"fileId": "file-x", "file": hint})
    world.pushed.clear()
    outcome = await world.run(state)

    binding = _binding(state, world, "file", "file-x")
    remote = _remote_root(world, "file", "file-x")
    assert "file-x" not in world.pushed
    if case == "changed_drive":
        # The existing relocation owner records where it is now; it is never "restored here".
        assert binding.status == "relocating" and binding.pending_drive_id == "shared-b"
        assert remote["status"] == "relocating"
    else:
        assert DETAIL in (binding.detail or "") and DETAIL in (remote["detail"] or "")
        assert outcome.authoritative_complete is False
    state.close()


@pytest.mark.asyncio
async def test_superseded_restoration_work_never_clears_the_detail(tmp_path, monkeypatch):
    # No backoff: were the stale upsert NOT superseded, the next run would read and push it.
    monkeypatch.setattr("aios_ingest.gdrive_sync._backoff_seconds", lambda *_a, **_k: 0)
    world = _file_world(monkeypatch)
    state = StateStore(str(tmp_path / "superseded.sqlite"))
    await _lose_file_x(world, state)

    # The restoration hint is owed, but its read is deferred this run…
    world.put("file-x", drive="shared-a")
    world.logs["shared-a"].append({"fileId": "file-x", "file": dict(world.files["file-x"])})
    world.unreadable["file-x"] = real_deferral(503)
    await world.run(state)
    assert DETAIL in (_binding(state, world, "file", "file-x").detail or "")
    # …and before it is retried, a newer observation removes the file again.
    world.unreadable.pop("file-x")
    world.files.pop("file-x")
    world.logs["shared-a"].append({"fileId": "file-x", "removed": True})
    world.pushed.clear()
    for _ in range(2):
        await world.run(state)

    upserts = state._db.execute(
        "SELECT superseded_at FROM pending_work WHERE item_key='file-x' AND action='upsert'",
    ).fetchall()
    assert upserts and all(row["superseded_at"] is not None for row in upserts)
    assert "file-x" not in world.pushed
    assert DETAIL in (_binding(state, world, "file", "file-x").detail or "")
    assert DETAIL in (_remote_root(world, "file", "file-x")["detail"] or "")
    state.close()


@pytest.mark.asyncio
async def test_a_refused_push_of_the_restored_root_never_clears_the_detail(tmp_path, monkeypatch):
    """Fresh metadata and extraction succeed, but the brain refuses the content: not restored."""
    from aios_ingest.brain_client import BrainError
    import aios_ingest.gdrive_sync as sync

    world = _file_world(monkeypatch)
    state = StateStore(str(tmp_path / "refused.sqlite"))
    await _lose_file_x(world, state)
    accepted_push = sync.BrainClient.push

    async def refuse_file_x(self, payload, *, execution):
        if payload.frontmatter["source_id"] == "file-x":
            raise BrainError(500, "server_error", "content not accepted")
        return await accepted_push(self, payload, execution=execution)

    monkeypatch.setattr(sync.BrainClient, "push", refuse_file_x)
    world.put("file-x", drive="shared-a")
    world.logs["shared-a"].append({"fileId": "file-x", "file": dict(world.files["file-x"])})
    world.calls.clear()
    outcome = await world.run(state)

    assert ("doc", "file-x") in world.calls  # metadata and extraction succeeded
    assert DETAIL in (_binding(state, world, "file", "file-x").detail or "")
    assert DETAIL in (_remote_root(world, "file", "file-x")["detail"] or "")
    assert outcome.authoritative_complete is False
    state.close()


def test_restoration_requires_fresh_metadata_in_the_bound_drive_of_this_stream(tmp_path):
    """The restoration predicate on its own: same stable id, bound, unavailable, this drive, a live Doc."""
    from types import SimpleNamespace

    from aios_ingest.gdrive_sync import _restorable_file_root
    from aios_ingest.state import PendingWork, StreamKey

    state = StateStore(str(tmp_path / "predicate.sqlite"))
    key = StreamKey("team", "conn", "account", "shared-a")
    state.begin_generation(key, GEN, start_token="t")
    state.bind_root("conn", GEN, "file", "file-x", "shared-a")
    assert state.record_root_unavailable("conn", GEN, "file", "file-x", detail=DETAIL + ": gone")
    execution = SimpleNamespace(integration_id="conn")
    work = PendingWork(key.namespace(GEN), GEN, "file-x", "upsert", 1, {}, 0, None, None, None, None)
    live = {"id": "file-x", "driveId": "shared-a", "mimeType": "application/vnd.google-apps.document"}

    def verdict(**meta):
        return _restorable_file_root(state, execution, key.namespace(GEN), GEN, work, {**live, **meta})

    assert verdict() == "file-x"
    assert verdict(driveId="shared-b") is None          # another drive
    assert verdict(trashed=True) is None                # trashed
    assert verdict(mimeType="application/pdf") is None  # unsupported content
    assert verdict(id="file-other") is None             # not the same stable id
    state.settle_root("conn", GEN, "file", "file-x")
    assert verdict() is None                            # nothing left to restore
    state.close()
