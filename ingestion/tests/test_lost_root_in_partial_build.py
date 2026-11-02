"""A folder lost while a snapshot is still building keeps none of its support (AIO-1167 final review).

Spec (accepted-spec AC-03/05/06; combined final-review adjudication §1, High). Folder root A has been
enumerated — its pages committed into the BUILDING snapshot — while A's own pagination or a sibling
root B keeps that build open. On a later run A's own metadata answers a verified not-found, and the
change feed carries no tombstone for A's children. Through the real coordinator over ``_DriveWorld``,
reopening SQLite between runs:

  * A's materialized support is withdrawn from the building snapshot before it can publish: no
    complete reconciliation ever holds an A-only document, and the brain's last success does not
    move before the replacement is complete;
  * support through any other root survives — a document also selected directly, one also under B —
    and so does another connection's claim on an A-only document; the gone folder is never listed;
  * the same holds whether A's traversal had finished (B alone held the build open) or was still
    unfinished (A's own pagination did), and across an interrupted publication — a refused checkpoint
    or one the brain stored whose acknowledgment was lost — and its replay;
  * an A restored after its loss was recorded, while the same build is still open, is not settled
    with no contents: it is deferred, the connection stays partial, and the controlled rescan lists it
    again before any complete reconciliation.
"""

from __future__ import annotations

import json

import pytest

from aios_ingest.gdrive_sync import _MAX_DISCOVERY_PAGES_PER_STREAM
from aios_ingest.state import StateStore
from test_document_restrictions import clock  # noqa: F401 (fixture)
from test_gdrive_upgrade import _SECOND_INTEGRATION, _ClaimLedger, _DriveWorld

GEN = 9
DRIVE = "shared-a"
# More listings than one run may make, so a folder of this size keeps a snapshot building.
BIG = _MAX_DISCOVERY_PAGES_PER_STREAM + 5


def _world(monkeypatch, *, a_folders: int = 0, b_folders: int = BIG):
    """Folder A (a document, a nested folder with another, ``a_folders`` more subfolders), folder B
    (a document, ``b_folders`` subfolders), a direct file selection, a document selected directly AND
    under A (``doc-ab``) and one under both A and B (``doc-both``)."""
    world = _DriveWorld(file_ids=["doc-direct", "doc-ab"], folder_ids=["folder-a", "folder-b"])
    world.install(monkeypatch)
    world.ledger = _ClaimLedger()
    world.put("folder-a", drive=DRIVE, folder=True)
    world.put("doc-a1", drive=DRIVE, parent="folder-a")
    world.put("folder-a-sub", drive=DRIVE, parent="folder-a", folder=True)
    world.put("doc-a2", drive=DRIVE, parent="folder-a-sub")
    for i in range(a_folders):
        world.put(f"folder-a{i}", drive=DRIVE, parent="folder-a", folder=True)
        world.put(f"doc-ax{i}", drive=DRIVE, parent=f"folder-a{i}")
    world.put("folder-b", drive=DRIVE, folder=True)
    world.put("doc-b", drive=DRIVE, parent="folder-b")
    for i in range(b_folders):
        world.put(f"folder-b{i}", drive=DRIVE, parent="folder-b", folder=True)
        world.put(f"doc-b{i}", drive=DRIVE, parent=f"folder-b{i}")
    world.put("doc-direct", drive=DRIVE)
    world.put("doc-ab", drive=DRIVE, parent="folder-a")
    world.put("doc-both", drive=DRIVE, parent="folder-a")
    world.files["doc-both"]["parents"] = ["folder-a", "folder-b"]
    return world


def _a_only(world) -> set[str]:
    """Documents A alone supports (``doc-ab`` and ``doc-both`` have other support)."""
    return {
        doc for doc in world.files
        if doc.startswith("doc-a") and doc not in {"doc-ab"}
    }


def _lose_folder_a(world) -> None:
    """A — and everything under it — is gone at the provider; NO change event says so. ``doc-ab``
    (also selected directly) and ``doc-both`` (also under B) survive elsewhere."""
    for gone in [k for k in world.files if k.startswith("folder-a") or (k.startswith("doc-a") and k != "doc-ab")]:
        world.files.pop(gone)
    world.files["doc-ab"]["parents"] = [DRIVE]
    world.files["doc-both"]["parents"] = ["folder-b"]


def _listed(world, folder: str) -> bool:
    return ("list", DRIVE, folder) in world.calls


async def _until_complete(world, state, limit: int = 60):
    summary = None
    for _ in range(limit):
        summary = await world.run(state)
        if summary.authoritative_complete:
            return summary
    raise AssertionError(f"not complete after {limit} runs: {summary}")


async def _rescan_listing_a(world, state, *, finished: bool) -> int:
    """Seed a controlled rescan (a change to folder B) and run until A has been enumerated into the
    building snapshot — its traversal finished or still open, as asked — while the build stays open.
    Returns the building snapshot's id."""
    namespace = world.namespace(DRIVE)
    world.logs.setdefault(DRIVE, []).append({"fileId": "folder-b", "file": dict(world.files["folder-b"])})
    world.calls.clear()
    for _ in range(6):
        await world.run(state)
        progress = state.get_progress(namespace)
        building = progress.building_snapshot
        if building is None or not _listed(world, "folder-a"):
            continue
        a_open = state.root_traversal_open(namespace, GEN, "folder-a", snapshot_id=building)
        if a_open != finished:
            assert state.has_membership(namespace, GEN, "doc-a1", snapshot_id=building)
            return int(building)
    raise AssertionError("the rescan never held A's enumeration in an open build")


async def _complete_after_loss(world, state_factory, *, last_success, a_only, faults=()):
    """Run (reopening SQLite after any interrupted run) until complete, asserting every complete
    reconciliation and the brain's last success along the way."""
    state = state_factory()
    world.checkpoint_faults.extend(faults)
    summary = None
    for _ in range(60):
        before = len(world.reconciled)
        try:
            summary = await world.run(state)
        except Exception:  # an interrupted publication: the process "dies" and restarts
            state.close()
            state = state_factory()
            summary = None
        for snapshot in world.reconciled[before:]:
            assert not a_only & set(snapshot), "a complete snapshot kept support of the lost folder"
        if summary is not None and summary.authoritative_complete:
            return state, summary
        assert world.stream(DRIVE).get("last_success_at") == last_success  # not before completion
    raise AssertionError(f"not complete: {summary}")


def _assert_only_a_support_retired(world, a_only: set[str]) -> None:
    survivors = {doc for doc in world.files if doc.startswith("doc-")}
    assert set(world.reconciled[-1]) == survivors
    assert {"doc-ab", "doc-both", "doc-direct", "doc-b"} <= survivors
    for doc in a_only - {"doc-a1"}:
        assert doc in world.ledger.deleted
    assert (world.integration_id, "doc-a1") in world.ledger.retired
    assert world.ledger.claims["doc-a1"] == {_SECOND_INTEGRATION}  # another connection's claim stands
    assert "doc-a1" not in world.ledger.deleted
    for doc in ("doc-ab", "doc-both", "doc-direct", "doc-b"):
        assert world.integration_id in world.ledger.claims[doc]


@pytest.mark.parametrize("finished", [
    pytest.param(True, id="a-traversal-finished-b-holds-the-build"),
    pytest.param(False, id="a-traversal-unfinished-a-holds-the-build"),
])
@pytest.mark.asyncio
async def test_a_folder_lost_in_a_partial_build_keeps_none_of_its_support(
    tmp_path, monkeypatch, clock, finished,
):
    world = _world(monkeypatch, a_folders=0 if finished else BIG, b_folders=BIG if finished else 0)
    path = str(tmp_path / "lost-in-build.sqlite")
    state = StateStore(path)
    await _until_complete(world, state)
    a_only = _a_only(world)
    assert a_only | {"doc-ab", "doc-both", "doc-direct", "doc-b"} <= set(world.reconciled[-1])
    world.ledger.push(_SECOND_INTEGRATION, "doc-a1")  # another connection also claims an A-only doc
    last_success = world.stream(DRIVE).get("last_success_at")

    await _rescan_listing_a(world, state, finished=finished)
    state.close()

    _lose_folder_a(world)
    world.calls.clear()
    state, summary = await _complete_after_loss(
        world, lambda: StateStore(path), last_success=last_success, a_only=a_only,
    )

    assert summary.authoritative_complete
    _assert_only_a_support_retired(world, a_only)
    # The gone folder and its subtree were never listed after the loss.
    assert not [call for call in world.calls if call[0] == "list" and str(call[2]).startswith("folder-a")]
    state.close()


@pytest.mark.parametrize("interruption", ["checkpoint-refused", "acknowledgment-lost"])
@pytest.mark.asyncio
async def test_the_withdrawal_survives_an_interrupted_publication_and_its_replay(
    tmp_path, monkeypatch, clock, interruption,
):
    world = _world(monkeypatch)
    path = str(tmp_path / f"lost-{interruption}.sqlite")
    state = StateStore(path)
    await _until_complete(world, state)
    a_only = _a_only(world)
    world.ledger.push(_SECOND_INTEGRATION, "doc-a1")
    last_success = world.stream(DRIVE).get("last_success_at")
    building = await _rescan_listing_a(world, state, finished=True)
    state.close()
    _lose_folder_a(world)

    def publishing(progress) -> bool:
        stream = (progress.get("streams") or {}).get(DRIVE) or {}
        return stream.get("active_snapshot") == building and stream.get("building_snapshot") is None

    def interrupt(progress):
        if not publishing(progress):
            return None
        if interruption == "acknowledgment-lost":
            # The brain stores the publication; its answer never reaches the sidecar.
            world.revision += 1
            world.progress = json.loads(json.dumps(progress))
        return RuntimeError("process died around the publication")

    state, summary = await _complete_after_loss(
        world, lambda: StateStore(path), last_success=last_success, a_only=a_only, faults=[interrupt],
    )
    assert summary.authoritative_complete
    assert interrupt not in world.checkpoint_faults  # the interruption really happened
    _assert_only_a_support_retired(world, a_only)
    state.close()


@pytest.mark.asyncio
async def test_a_folder_restored_after_its_loss_in_the_same_build_is_listed_again_before_completion(
    tmp_path, monkeypatch, clock,
):
    # B is large enough to keep the build open across the loss AND the restore.
    world = _world(monkeypatch, b_folders=4 * BIG)
    path = str(tmp_path / "restored-in-build.sqlite")
    state = StateStore(path)
    await _until_complete(world, state)
    a_docs = {"doc-a1", "doc-a2", "doc-ab", "doc-both"}
    assert a_docs <= set(world.reconciled[-1])
    world.ledger.push(_SECOND_INTEGRATION, "doc-a1")
    last_success = world.stream(DRIVE).get("last_success_at")
    namespace = world.namespace(DRIVE)
    building = await _rescan_listing_a(world, state, finished=True)
    reconciled = len(world.reconciled)

    # Lost: its support is withdrawn from the open build.
    saved = {k: json.loads(json.dumps(v)) for k, v in world.files.items()}
    _lose_folder_a(world)
    state.close()
    state = StateStore(path)
    await world.run(state)
    assert state.get_progress(namespace).building_snapshot == building  # still building
    assert not state.has_membership(namespace, GEN, "doc-a1", snapshot_id=building)
    assert len(world.reconciled) == reconciled

    # Restored while the same build is open: deferred, not settled with no contents.
    world.files.clear()
    world.files.update(saved)
    world.calls.clear()
    state.close()
    state = StateStore(path)
    await world.run(state)
    assert ("folder", "folder-a") in state.deferred_roots(world.integration_id, GEN, DRIVE)

    summary = None
    for _ in range(60):
        before = len(world.reconciled)
        summary = await world.run(state)
        for snapshot in world.reconciled[before:]:
            assert a_docs <= set(snapshot), "complete without the restored folder's contents"
            assert _listed(world, "folder-a") and _listed(world, "folder-a-sub")
        if summary.authoritative_complete:
            break
        assert world.stream(DRIVE).get("last_success_at") == last_success
    assert summary is not None and summary.authoritative_complete
    assert ("folder", "folder-a") not in state.deferred_roots(world.integration_id, GEN, DRIVE)
    assert world.ledger.claims["doc-a1"] == {world.integration_id, _SECOND_INTEGRATION}
    for doc in a_docs:
        assert doc not in world.ledger.deleted
    state.close()
