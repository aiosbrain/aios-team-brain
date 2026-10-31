"""A previously bound selected root's verified loss has a durable outcome (AIO-1167 R48 D1).

Spec (accepted-spec AC-03/05/07; Astra R47 adjudication D1). Through the real coordinator over the
``_DriveWorld`` double (Google and the brain as the coordinator's own calls see them):

  * a bound folder root that is hard-deleted — its OWN metadata answers 404 — is recorded as
    unavailable (bound, with an actionable detail that travels in the fenced root evidence). Its
    traversal is finished without listing it, the rescan publishes, the cursor advances, and no
    generic ``provider_read`` is reported — even when Google answers the folder's listing 404;
  * a bound file root that disappears before a 410 rescan finishes its page empty the same way;
  * only that root's support is retired: a directly selected document under it, another root's
    documents and another connection's claim all survive;
  * completion is restart-safe, and a fresh state file restoring the brain re-derives it;
  * another root that cannot be verified keeps the run partial and withholds scope-wide absence;
    an auth / permission / server error on the root, a listing 404 of a folder that exists, and a
    never-bound root are never treated as loss;
  * a restored root is enumerated again, under the same provider identity, once it can be read.
"""

from __future__ import annotations

import pytest

from aios_ingest.sources.gdrive import ProviderCursorInvalid
from aios_ingest.state import StateStore
from test_gdrive_upgrade import _ClaimLedger, _DriveWorld, _ProviderHttpError

GEN = 9
DETAIL = "selected root unavailable"


def _binding(state, world, kind, root_id):
    return state.root_obligations(world.integration_id, GEN).get((kind, root_id))


def _remote_root(world, kind, root_id):
    return next(
        item for item in world.progress["roots"]["items"]
        if item["kind"] == kind and item["id"] == root_id
    )


def _folder_world(monkeypatch, *, file_ids=("doc-1",)):
    """``folder-r`` (doc-1, and folder-n holding doc-2) and ``folder-k`` (doc-k) in one Shared Drive;
    doc-1 is also selected directly."""
    world = _DriveWorld(file_ids=list(file_ids), folder_ids=["folder-r", "folder-k"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("folder-n", drive="shared-a", parent="folder-r", folder=True)
    world.put("folder-k", drive="shared-a", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-r")
    world.put("doc-2", drive="shared-a", parent="folder-n")
    world.put("doc-k", drive="shared-a", parent="folder-k")
    world.missing_folder_listing_404 = True
    return world


def _delete_folder_r(world):
    """folder-r is hard-deleted for this account; doc-1 stays shared directly with it."""
    for gone in ("folder-r", "folder-n", "doc-2"):
        world.files.pop(gone)
    world.logs.setdefault("shared-a", []).append({"fileId": "folder-r", "removed": True})


@pytest.mark.asyncio
async def test_a_hard_deleted_bound_folder_root_completes_its_rescan_and_retires_only_its_support(
    tmp_path, monkeypatch,
):
    world = _folder_world(monkeypatch)
    world.ledger = _ClaimLedger()
    world.ledger.push("another-connection", "doc-2")  # another connection also claims doc-2
    path = str(tmp_path / "folder-loss.sqlite")
    state = StateStore(path)
    namespace = world.namespace("shared-a")
    assert (await world.run(state)).authoritative_complete is True
    assert world.reconciled == [["doc-1", "doc-2", "doc-k"]]

    _delete_folder_r(world)
    world.calls.clear()
    world.pushed.clear()
    # The tombstone page: doc-2 (under folder-r only) is a positive removal, and a rescan is seeded.
    seeded = await world.run(state)
    assert seeded.authoritative_complete is False
    assert state.next_uncommitted_page(namespace, GEN).rescan_snapshot_id is not None
    # The rescan, on the next run.
    summary = await world.run(state)

    # The deleted root was read once, positively not found, and never listed.
    assert ("metadata", "folder-r") in world.calls
    assert not any(call[0] == "list" and call[2] in ("folder-r", "folder-n") for call in world.calls)
    assert "provider_read" not in summary.failure_categories
    assert summary.failure_categories.get("selection_root_unavailable") == 1
    # The rescan published and the cursor passed the tombstone page.
    progress = state.get_progress(namespace)
    assert progress.building_snapshot is None and progress.listing_complete is True
    assert state.next_uncommitted_page(namespace, GEN) is None
    # Only folder-r's support is retired: the direct selection and the other root stand.
    assert state.membership_ids(namespace, GEN) == ["doc-1", "doc-k"]
    assert summary.authoritative_complete is True
    assert world.reconciled[-1] == ["doc-1", "doc-k"]
    assert "doc-1" not in world.removed and "doc-k" not in world.removed
    # Another connection's claim on doc-2 survives this connection's reconciliation.
    assert ("another-connection" in world.ledger.claims["doc-2"]) and "doc-2" not in world.ledger.deleted
    # The outcome is durable root evidence, locally and on the brain, with an actionable detail.
    binding = _binding(state, world, "folder", "folder-r")
    assert binding.status == "bound" and DETAIL in (binding.detail or "")
    assert DETAIL in (_remote_root(world, "folder", "folder-r")["detail"] or "")
    state.close()

    assert "doc-2" not in world.pushed  # the lost root's document is never re-ingested

    # Restart: nothing is re-listed, nothing is re-pushed, and it stays complete.
    state = StateStore(path)
    world.calls.clear()
    world.pushed.clear()
    again = await world.run(state)
    assert not any(call[0] == "list" and call[2] == "folder-r" for call in world.calls)
    assert "provider_read" not in again.failure_categories
    assert world.pushed == []
    state.close()


@pytest.mark.asyncio
async def test_a_fresh_state_file_re_derives_the_lost_roots_outcome_from_the_brain(tmp_path, monkeypatch):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / "first.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    _delete_folder_r(world)
    await world.run(state)  # tombstone page; rescan seeded
    assert (await world.run(state)).authoritative_complete is True
    state.close()

    fresh = StateStore(str(tmp_path / "fresh.sqlite"))
    world.calls.clear()
    restored = await world.run(fresh)
    assert not any(call[0] == "list" and call[2] in ("folder-r", "folder-n") for call in world.calls)
    assert "provider_read" not in restored.failure_categories
    assert restored.failed == 0
    assert "doc-2" not in world.reconciled[-1]
    fresh.close()


@pytest.mark.asyncio
async def test_a_bound_file_root_lost_before_a_410_rescan_finishes_its_page_empty(tmp_path, monkeypatch):
    world = _DriveWorld(file_ids=["file-x", "file-y"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("file-y", drive="shared-a")
    path = str(tmp_path / "file-loss.sqlite")
    state = StateStore(path)
    namespace = world.namespace("shared-a")
    assert (await world.run(state)).authoritative_complete is True
    assert world.reconciled == [["file-x", "file-y"]]

    world.files.pop("file-x")
    world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
    assert (await world.run(state)).failure_categories.get("invalid_cursor") == 1
    world.cursor_errors.clear()
    world.pushed.clear()
    summary = await world.run(state)

    assert "provider_read" not in summary.failure_categories
    assert summary.failure_categories.get("selection_root_unavailable") == 1
    assert state.next_uncommitted_page(namespace, GEN) is None
    assert state.membership_ids(namespace, GEN) == ["file-y"]
    assert summary.authoritative_complete is True and world.reconciled[-1] == ["file-y"]
    assert "file-x" not in world.pushed
    assert DETAIL in (_binding(state, world, "file", "file-x").detail or "")
    state.close()


@pytest.mark.asyncio
async def test_another_unverifiable_root_keeps_the_run_partial_and_withholds_absence(tmp_path, monkeypatch):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / "partial.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    reconciled = list(world.reconciled)

    _delete_folder_r(world)
    world.unreadable["folder-k"] = _ProviderHttpError(500)  # the other root cannot be read now
    await world.run(state)  # tombstone page; rescan seeded
    for _ in range(2):  # the rescan meets the unverifiable root, run after run
        summary = await world.run(state)
        assert summary.authoritative_complete is False
        assert world.reconciled == reconciled  # no scope-wide absence
    # The other root's documents keep their claims; only the positive tombstone removal flowed.
    assert "doc-k" not in world.removed and "doc-1" not in world.removed
    state.close()


@pytest.mark.parametrize("status", [401, 403, 500])
@pytest.mark.asyncio
async def test_an_auth_permission_or_server_error_on_the_root_is_never_loss(tmp_path, monkeypatch, status):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / f"err-{status}.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    reconciled = list(world.reconciled)

    # The change log reports the folder, but its metadata answers an error that proves nothing.
    world.logs.setdefault("shared-a", []).append({"fileId": "folder-r", "file": dict(world.files["folder-r"])})
    world.unreadable["folder-r"] = _ProviderHttpError(status)
    world.calls.clear()
    for _ in range(3):  # the change page, then the rescan that reads the root, run after run
        summary = await world.run(state)
        assert "selection_root_unavailable" not in summary.failure_categories
        assert summary.authoritative_complete is False
    assert ("metadata", "folder-r") in world.calls  # the root really was read
    binding = _binding(state, world, "folder", "folder-r")
    assert DETAIL not in (binding.detail or "")
    assert world.reconciled == reconciled and world.removed == []
    state.close()


@pytest.mark.asyncio
async def test_a_listing_404_of_a_folder_that_exists_is_not_absence(tmp_path, monkeypatch):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / "listing-404.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    reconciled = list(world.reconciled)

    def listing_404():
        raise _ProviderHttpError(404)

    world.logs.setdefault("shared-a", []).append({"fileId": "folder-n", "file": dict(world.files["folder-n"])})
    world.hooks[("list", "shared-a", "folder-r")] = listing_404
    world.calls.clear()
    outcomes = [await world.run(state), await world.run(state)]

    assert ("list", "shared-a", "folder-r") in world.calls  # the rescan listed it, and was refused
    assert all("selection_root_unavailable" not in o.failure_categories for o in outcomes)
    assert outcomes[1].authoritative_complete is False
    assert world.reconciled == reconciled and world.removed == []
    assert DETAIL not in (_binding(state, world, "folder", "folder-r").detail or "")
    state.close()


@pytest.mark.asyncio
async def test_a_never_bound_root_404_stays_unresolved_not_lost(tmp_path, monkeypatch):
    world = _DriveWorld(folder_ids=["folder-ghost", "folder-k"]).install(monkeypatch)
    world.put("folder-k", drive="shared-a", folder=True)
    world.put("doc-k", drive="shared-a", parent="folder-k")
    state = StateStore(str(tmp_path / "ghost.sqlite"))

    summary = await world.run(state)

    assert summary.failure_categories.get("selection_root_unresolved") == 1
    assert "selection_root_unavailable" not in summary.failure_categories
    assert _binding(state, world, "folder", "folder-ghost").status == "unresolved"
    assert summary.authoritative_complete is False and world.reconciled == []
    state.close()


@pytest.mark.asyncio
async def test_a_restored_root_is_enumerated_again_under_the_same_identity(tmp_path, monkeypatch):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / "restore.sqlite"))
    namespace = world.namespace("shared-a")
    assert (await world.run(state)).authoritative_complete is True
    _delete_folder_r(world)
    await world.run(state)  # tombstone page; rescan seeded
    assert (await world.run(state)).authoritative_complete is True
    assert "doc-2" not in state.membership_ids(namespace, GEN)

    # Access returns: the folder and its documents are readable again and the log reports it.
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("folder-n", drive="shared-a", parent="folder-r", folder=True)
    world.put("doc-2", drive="shared-a", parent="folder-n")
    world.logs["shared-a"].append({"fileId": "folder-r", "file": dict(world.files["folder-r"])})
    world.pushed.clear()
    world.calls.clear()
    restored = await world.run(state)
    if not restored.authoritative_complete:
        restored = await world.run(state)  # a page that seeds a rescan publishes on the next run

    assert ("list", "shared-a", "folder-r") in world.calls
    assert "doc-2" in state.membership_ids(namespace, GEN)
    assert "doc-2" in world.pushed  # the same provider id: no new content identity
    binding = _binding(state, world, "folder", "folder-r")
    assert binding.status == "bound" and not binding.detail
    assert restored.authoritative_complete is True and "doc-2" in world.reconciled[-1]
    state.close()
