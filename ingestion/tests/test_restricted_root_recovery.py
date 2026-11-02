"""A restricted selected root does not freeze recovery (AIO-1167 R50 F4), and its diagnostics are
truthful (R50 F7).

Spec (Astra R49 adjudication, findings 4 and 7). Through the real coordinator over ``_DriveWorld``:

F4 — after a 410 controlled rescan, and separately after fresh-state recovery, a selected file root
under a standing provider minimum is not read; it becomes a durable DEFERRED obligation. Its page
commits carrying only the membership the published snapshot already proved (none on fresh state:
nothing is invented), so the stream publishes and an independent document's LATER edit — same drive
or another drive — still flows, while the run stays partial and no complete snapshot infers absence.
Once the minimum passes, the next run lists the root again (restoration), and a removal that arrived
while it was restricted is applied only through that verified path; stale upsert work never pushes
removed content.

F7 — a root verified unavailable is counted once per run however many phases observe it, and a newly
learned restriction that no checkpoint got acknowledged is reported ``document_restriction_unpublished``.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from aios_ingest.brain_client import BrainError
from aios_ingest.engine import IngestSummary
from aios_ingest.gdrive_sync import _merge_summary, _note_root_unavailable
from aios_ingest.sources.gdrive import ProviderCursorInvalid
from aios_ingest.state import StateStore
from test_bound_root_loss import _delete_folder_r, _folder_world
from test_document_restrictions import (  # noqa: F401 (clock is a fixture)
    LONG, _restrict_after_seven_failures, clock,
)
from test_document_restrictions import _world as _restriction_world
from test_gdrive_upgrade import _WORLD_INTEGRATION, _DriveWorld

GEN = 9
DEFERRED = "selected root deferred"


def _world(monkeypatch):
    world = _DriveWorld(file_ids=["file-x", "file-y"], folder_ids=["folder-z"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("file-y", drive="shared-a")
    world.put("folder-z", drive="shared-b", folder=True)
    world.put("doc-z", drive="shared-b", parent="folder-z")
    return world


def _restrict(world, provider_id: str, not_before: str) -> None:
    """A provider minimum the brain already acknowledged for this account (adopted on the next run)."""
    world.progress["document_restrictions"] = {
        "generation": GEN, "credential": "account",
        "items": [{"id": provider_id, "not_before": not_before,
                   "category": "provider_unavailable", "unrepresentable": False}],
    }


def _edit(world, provider_id: str, drive: str, when: str) -> None:
    world.files[provider_id]["modifiedTime"] = when
    world.logs.setdefault(drive, []).append({"fileId": provider_id, "file": dict(world.files[provider_id])})


def _binding(state, kind, root_id):
    return state.root_obligations(_WORLD_INTEGRATION, GEN).get((kind, root_id))


async def _rescan_with_file_x_restricted(world, state, clock, minutes=60 * 24 * 30):
    """Baseline, then file-x is restricted and a 410 forces a controlled rescan of shared-a."""
    assert (await world.run(state)).authoritative_complete is True
    reconciled = list(world.reconciled)
    _restrict(world, "file-x", (clock.at + timedelta(minutes=minutes)).isoformat())
    world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
    await world.run(state)
    world.cursor_errors.clear()
    world.calls.clear()
    await world.run(state)  # the rescan
    return reconciled


@pytest.mark.asyncio
async def test_after_a_410_rescan_a_restricted_file_root_is_deferred_and_independent_edits_flow(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "rescan.sqlite"))
    namespace = world.namespace("shared-a")
    reconciled = await _rescan_with_file_x_restricted(world, state, clock)

    assert ("metadata", "file-x") not in world.calls and ("metadata", "file-y") in world.calls
    progress = state.get_progress(namespace)
    assert progress.building_snapshot is None and progress.listing_complete is True  # published
    binding = _binding(state, "file", "file-x")
    assert binding.status == "uncertain" and (binding.detail or "").startswith(DEFERRED)
    assert "file-x" in state.membership_ids(namespace, GEN)  # retained, not invented

    # Edits AFTER the baseline page committed, same drive and another drive: both flow.
    world.pushed.clear()
    world.calls.clear()
    _edit(world, "file-y", "shared-a", "2026-10-01T00:00:00Z")
    _edit(world, "doc-z", "shared-b", "2026-10-01T00:00:00Z")
    outcome = await world.run(state)
    assert "file-y" in world.pushed and "doc-z" in world.pushed
    assert ("metadata", "file-x") not in world.calls and "file-x" not in world.pushed
    assert outcome.authoritative_complete is False
    assert world.reconciled == reconciled and "file-x" not in world.removed  # no inferred absence
    state.close()


@pytest.mark.asyncio
async def test_after_fresh_state_recovery_a_restricted_file_root_invents_no_membership(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "first.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    reconciled = list(world.reconciled)
    state.close()
    _restrict(world, "file-x", (clock.at + timedelta(days=30)).isoformat())

    fresh = StateStore(str(tmp_path / "fresh.sqlite"))
    namespace = world.namespace("shared-a")
    world.calls.clear()
    for _ in range(2):
        await world.run(fresh)
    assert ("metadata", "file-x") not in world.calls
    assert "file-x" not in state_membership(fresh, namespace)  # fresh state: nothing invented
    assert "file-y" in state_membership(fresh, namespace)
    binding = _binding(fresh, "file", "file-x")
    assert binding.status == "uncertain" and (binding.detail or "").startswith(DEFERRED)

    world.pushed.clear()
    _edit(world, "file-y", "shared-a", "2026-10-02T00:00:00Z")
    _edit(world, "doc-z", "shared-b", "2026-10-02T00:00:00Z")
    outcome = await world.run(fresh)
    assert "file-y" in world.pushed and "doc-z" in world.pushed and "file-x" not in world.pushed
    assert outcome.authoritative_complete is False
    assert world.reconciled == reconciled and "file-x" not in world.removed
    fresh.close()


def state_membership(state, namespace):
    return state.membership_ids(namespace, GEN)


@pytest.mark.asyncio
async def test_once_the_minimum_passes_the_deferred_root_is_listed_again_and_the_connection_completes(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "restore.sqlite"))
    await _rescan_with_file_x_restricted(world, state, clock, minutes=2)
    assert ("metadata", "file-x") not in world.calls

    clock.at += timedelta(minutes=5)
    world.calls.clear()
    world.pushed.clear()
    outcome = None
    for _ in range(3):
        outcome = await world.run(state)
        if outcome.authoritative_complete:
            break
    assert ("metadata", "file-x") in world.calls  # listed again by the controlled rescan
    binding = _binding(state, "file", "file-x")
    assert binding.status == "bound" and not binding.detail
    assert outcome is not None and outcome.authoritative_complete is True
    assert "file-x" in world.reconciled[-1]
    state.close()


@pytest.mark.asyncio
async def test_a_removal_while_restricted_is_applied_only_through_the_verified_path(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "removal.sqlite"))
    await _rescan_with_file_x_restricted(world, state, clock, minutes=2)

    # file-x is deleted while it is restricted: its claims stand, nothing is removed yet.
    world.files.pop("file-x")
    world.logs["shared-a"].append({"fileId": "file-x", "removed": True})
    world.pushed.clear()
    await world.run(state)
    assert "file-x" not in world.removed

    # The minimum passes: the root is read again, found gone (its own 404), and only then retired.
    clock.at += timedelta(minutes=5)
    outcome = None
    for _ in range(4):
        outcome = await world.run(state)
        if outcome.authoritative_complete:
            break
    assert "file-x" not in world.pushed  # stale upsert work never restored removed content
    assert outcome is not None and outcome.authoritative_complete is True
    assert "file-x" not in world.reconciled[-1]
    state.close()


@pytest.mark.asyncio
async def test_a_root_verified_unavailable_twice_in_one_run_counts_once(tmp_path, monkeypatch):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / "count.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    _delete_folder_r(world)
    first = await world.run(state)  # the tombstone page reads folder-r: not found
    assert first.failure_categories.get("selection_root_unavailable") == 1

    # The seeded rescan reads folder-r again, and a duplicate tombstone page reads it once more.
    world.logs["shared-a"].append({"fileId": "folder-r", "removed": True})
    world.calls.clear()
    second = await world.run(state)
    assert world.calls.count(("metadata", "folder-r")) >= 1
    assert second.failure_categories.get("selection_root_unavailable") == 1
    state.close()


def test_root_unavailable_counts_deduplicate_across_phases_and_streams():
    stream_a = IngestSummary("docs", failure_categories={})
    _note_root_unavailable(stream_a, "folder", "folder-r")
    _note_root_unavailable(stream_a, "folder", "folder-r")  # baseline, then a change page
    stream_b = IngestSummary("docs", failure_categories={})
    _note_root_unavailable(stream_b, "folder", "folder-r")  # another stream saw the same root
    _note_root_unavailable(stream_b, "file", "file-q")
    total = IngestSummary("docs", failure_categories={})
    _merge_summary(total, stream_a)
    _merge_summary(total, stream_b)
    assert stream_a.failure_categories["selection_root_unavailable"] == 1
    assert total.failure_categories["selection_root_unavailable"] == 2


@pytest.mark.asyncio
async def test_a_newly_learned_restriction_no_checkpoint_carried_is_reported_unpublished(
    tmp_path, monkeypatch, clock,
):
    world = _restriction_world(monkeypatch)
    state = StateStore(str(tmp_path / "unpublished.sqlite"))
    from test_account_hold_before_streams import provider_deferral
    from test_document_restrictions import run
    from aios_ingest.gdrive_sync import _MAX_AUTOMATIC_ATTEMPTS
    from test_gdrive_upgrade import _ProviderHttpError

    world.unreadable["doc-a"] = _ProviderHttpError(500)
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS - 1):
        await run(world, state)
        clock.at += timedelta(seconds=1)
    world.unreadable["doc-a"] = provider_deferral(503, LONG)
    world.checkpoint_faults.extend([lambda _payload: BrainError(503, "unavailable", "lost")] * 20)
    lost = await run(world, state)
    world.checkpoint_faults.clear()

    assert lost.failure_categories.get("document_restriction_unpublished") == 1
    assert state.document_restrictions(world.integration_id, GEN, "account").get("doc-a") is not None
    assert "doc-a" not in [
        item["id"] for item in (world.progress.get("document_restrictions") or {}).get("items", [])
    ]

    published = await run(world, state)  # acknowledged now: reported no more
    assert "document_restriction_unpublished" not in published.failure_categories
    assert [item["id"] for item in world.progress["document_restrictions"]["items"]] == ["doc-a"]
    state.close()
