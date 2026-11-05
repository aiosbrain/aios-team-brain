"""A deferred folder is settled only by listing its subtree, never by its metadata (AIO-1167 R51 final 1).

Spec (accepted-spec AC-03/05/07; Astra 20:01 UTC adjudication, finding 1). A folder root whose read
was deferred while a snapshot was being built has only a placeholder in that build — retained
membership, none on fresh local state. Reading the folder's metadata later proves where it is, not
what is under it. Through the real coordinator over ``_DriveWorld``:

  * with existing brain claims and FRESH local state, folder A deferred and the build kept open by a
    sibling larger than one run's discovery budget, a restart in which A's metadata recovers and the
    change feed is empty lists A AND its nested folder before any complete reconciliation; every
    complete snapshot holds A's documents, their claims survive, and the brain's last success does
    not move until the connection is genuinely complete;
  * with RETAINED local membership, a document under A that is gone at the provider (no change the
    stream can see) is NOT kept by the placeholder: the subtree is listed again and the complete
    snapshot retires its claim — never reported complete with stale membership;
  * a recovered listing interrupted part-way leaves A deferred and the connection incomplete; after a
    restart it resumes, lists the rest, settles A and completes.

Post-blind corrections (Astra adjudication of Fable's R51 findings):

  * F1 — ordinary uncertainty (a non-deferral metadata error, here on the change-page path) never
    erases A's deferred marker: it survives a reopened SQLite file, metadata recovery alone does not
    settle A, A and its nested folder are listed before any complete reconciliation, existing claims
    survive and last success waits for completion. Ordinary uncertainty on a root that was never
    deferred is still settled by metadata recovery (control);
  * F3 — a deferred folder whose placeholder already closed its traversal, then answering 404, is not
    read in that build: a controlled replacement snapshot decides it, so no complete reconciliation
    carries its stale placeholder membership, it is never listed, and only its unsupported membership
    disappears — the direct selection, the sibling root and another connection's claim stay.
"""

from __future__ import annotations

import pytest

from aios_ingest.gdrive_sync import _MAX_DISCOVERY_PAGES_PER_STREAM
from aios_ingest.state import ROOT_DEFERRED_PREFIX, StateStore
from test_document_restrictions import clock  # noqa: F401 (fixture)
from test_gdrive_upgrade import _SECOND_INTEGRATION, _ClaimLedger, _DriveWorld, _ProviderHttpError
from test_root_evidence_r49 import real_deferral

GEN = 9
DRIVE = "shared-a"
# More listings than one run may make, so a folder of this size keeps a snapshot building.
BIG = _MAX_DISCOVERY_PAGES_PER_STREAM + 5
A_DOCS = {"doc-a1", "doc-a2"}


def _world(monkeypatch, *, big_a: bool = False, big_b: bool = True):
    world = _DriveWorld(folder_ids=["folder-a", "folder-b"]).install(monkeypatch)
    world.ledger = _ClaimLedger()
    world.put("folder-a", drive=DRIVE, folder=True)
    world.put("folder-a-sub", drive=DRIVE, parent="folder-a", folder=True)
    world.put("doc-a1", drive=DRIVE, parent="folder-a")
    world.put("doc-a2", drive=DRIVE, parent="folder-a-sub")
    if big_a:
        for i in range(BIG):
            world.put(f"folder-a{i}", drive=DRIVE, parent="folder-a", folder=True)
            world.put(f"doc-ax{i}", drive=DRIVE, parent=f"folder-a{i}")
    world.put("folder-b", drive=DRIVE, folder=True)
    world.put("doc-b", drive=DRIVE, parent="folder-b")
    if big_b:
        for i in range(BIG):
            world.put(f"folder-b{i}", drive=DRIVE, parent="folder-b", folder=True)
            world.put(f"doc-b{i}", drive=DRIVE, parent=f"folder-b{i}")
    return world


async def _until_complete(world, state, limit: int = 40):
    summary = None
    for _ in range(limit):
        summary = await world.run(state)
        if summary.authoritative_complete:
            return summary
    raise AssertionError(f"not complete after {limit} runs: {summary}")


def _deferred(state, world) -> bool:
    return ("folder", "folder-a") in state.deferred_roots(world.integration_id, GEN, DRIVE)


def _listed(world, folder: str) -> bool:
    return ("list", DRIVE, folder) in world.calls


@pytest.mark.asyncio
async def test_fresh_state_with_brain_claims_lists_the_recovered_folder_before_any_complete_snapshot(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    first_state = StateStore(str(tmp_path / "first.sqlite"))
    await _until_complete(world, first_state)
    first_state.close()
    assert A_DOCS <= set(world.reconciled[-1])
    last_success = world.stream(DRIVE).get("last_success_at")

    # Fresh local state; folder A's read is deferred (a 503 naming no minimum).
    world.unreadable["folder-a"] = real_deferral(503)
    path = str(tmp_path / "fresh.sqlite")
    state = StateStore(path)
    world.calls.clear()
    await world.run(state)
    progress = state.get_progress(world.namespace(DRIVE))
    assert progress.building_snapshot is not None  # the sibling keeps this build open
    assert _deferred(state, world)
    assert not _listed(world, "folder-a")
    state.close()

    # Restart: A's metadata recovers; the change feed is empty.
    world.unreadable.pop("folder-a")
    state = StateStore(path)
    summary = None
    for _ in range(40):
        mark = len(world.reconciled)
        summary = await world.run(state)
        for snapshot in world.reconciled[mark:]:
            assert A_DOCS <= set(snapshot), "a complete snapshot without folder A's subtree"
            assert _listed(world, "folder-a") and _listed(world, "folder-a-sub")
        if summary.authoritative_complete:
            break
        assert world.stream(DRIVE).get("last_success_at") == last_success  # not before completion
    assert summary is not None and summary.authoritative_complete
    assert _listed(world, "folder-a") and _listed(world, "folder-a-sub")
    for doc in A_DOCS:
        assert world.ledger.claims[doc] == {world.integration_id}  # the existing claims survive
        assert doc not in world.ledger.deleted
    assert not _deferred(state, world)
    state.close()


@pytest.mark.asyncio
async def test_retained_membership_never_keeps_a_document_the_recovered_listing_does_not_find(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    path = str(tmp_path / "retained.sqlite")
    state = StateStore(path)
    await _until_complete(world, state)
    assert A_DOCS <= set(world.reconciled[-1])

    # A rescan is seeded by a change to a folder under B; folder A's read is deferred during it.
    world.logs.setdefault(DRIVE, []).append({"fileId": "folder-b0", "file": dict(world.files["folder-b0"])})
    world.unreadable["folder-a"] = real_deferral(503)
    for _ in range(4):
        await world.run(state)
        progress = state.get_progress(world.namespace(DRIVE))
        if progress.building_snapshot is not None and _deferred(state, world):
            break
    assert progress.building_snapshot is not None and _deferred(state, world)

    # doc-a2 is gone at the provider, with no change this stream can see; A becomes readable again.
    world.files.pop("doc-a2")
    world.unreadable.pop("folder-a")
    mark = len(world.reconciled)
    summary = None
    for _ in range(40):
        before = len(world.reconciled)
        summary = await world.run(state)
        for snapshot in world.reconciled[before:]:
            assert "doc-a2" not in snapshot, "complete with stale retained membership"
        if summary.authoritative_complete:
            break
    assert summary is not None and summary.authoritative_complete
    assert len(world.reconciled) > mark
    assert "doc-a1" in world.reconciled[-1] and "doc-a2" not in world.reconciled[-1]
    assert (world.integration_id, "doc-a2") in world.ledger.retired
    assert _listed(world, "folder-a-sub")
    state.close()


@pytest.mark.asyncio
async def test_an_interrupted_recovered_listing_keeps_the_folder_deferred_and_resumes_after_restart(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch, big_a=True, big_b=False)
    path = str(tmp_path / "interrupted.sqlite")
    state = StateStore(path)
    await _until_complete(world, state)
    a_docs = {doc for doc in world.files if doc.startswith("doc-a")}
    assert a_docs <= set(world.reconciled[-1])

    # Folder A is deferred during a controlled rescan, which publishes without it.
    world.logs.setdefault(DRIVE, []).append({"fileId": "folder-b", "file": dict(world.files["folder-b"])})
    world.unreadable["folder-a"] = real_deferral(503)
    for _ in range(6):
        await world.run(state)
        progress = state.get_progress(world.namespace(DRIVE))
        if progress.building_snapshot is None and _deferred(state, world):
            break
    assert _deferred(state, world)
    reconciled = len(world.reconciled)

    # A recovers; its listing needs more than one run's discovery budget.
    world.unreadable.pop("folder-a")
    world.calls.clear()
    interrupted = await world.run(state)
    # Part-way (A alone needs more listings than one run may make): still deferred, and nothing
    # was reconciled on a partial listing.
    assert not interrupted.authoritative_complete
    assert _deferred(state, world)
    assert len(world.reconciled) == reconciled
    state.close()

    state = StateStore(path)  # restart
    summary = await _until_complete(world, state)
    assert summary.authoritative_complete
    assert a_docs <= set(world.reconciled[-1])
    assert not _deferred(state, world)
    assert _listed(world, "folder-a")
    state.close()


# ------------------------------------------------------------------------------------------------ #
# R51 post-blind F1 — ordinary uncertainty keeps the deferred listing debt
# ------------------------------------------------------------------------------------------------ #

def _obligation(state, connection, root_id):
    return state.root_obligations(connection, GEN)[("folder", root_id)]


def test_ordinary_uncertainty_keeps_the_deferred_marker_and_only_a_listing_or_verified_transition_discharges_it(
    tmp_path,
):
    connection = "00000000-0000-0000-0000-0000000000f1"
    path = str(tmp_path / "markers.sqlite")
    state = StateStore(path)
    for root_id in ("folder-a", "folder-c", "folder-r", "folder-u"):
        state.bind_root(connection, GEN, "folder", root_id, DRIVE)
    state.mark_root_deferred(connection, GEN, "folder", "folder-a", DRIVE, detail="its read is withheld")
    # A non-deferral metadata error on the deferred root, and on one that was never deferred (control).
    state.mark_root_uncertain(connection, GEN, "folder", "folder-a", DRIVE, detail="root metadata unreadable (403)")
    state.mark_root_uncertain(connection, GEN, "folder", "folder-c", DRIVE, detail="root metadata unreadable (403)")
    state.close()

    state = StateStore(path)  # reopened
    deferred = _obligation(state, connection, "folder-a")
    assert deferred.status == "uncertain" and deferred.detail.startswith(ROOT_DEFERRED_PREFIX)
    assert state.deferred_roots(connection, GEN, DRIVE) == [("folder", "folder-a")]
    assert _obligation(state, connection, "folder-c").detail == "root metadata unreadable (403)"

    # Metadata recovery settles the ordinary uncertainty only; the deferred root still owes its listing.
    state.settle_root(connection, GEN, "folder", "folder-a")
    state.settle_root(connection, GEN, "folder", "folder-c")
    assert _obligation(state, connection, "folder-a").status == "uncertain"
    assert state.deferred_roots(connection, GEN, DRIVE) == [("folder", "folder-a")]
    control = _obligation(state, connection, "folder-c")
    assert control.status == "bound" and control.detail is None

    # A newer deferral still records its own detail; the listing settles it.
    state.mark_root_deferred(connection, GEN, "folder", "folder-a", DRIVE, detail="again")
    assert _obligation(state, connection, "folder-a").detail == f"{ROOT_DEFERRED_PREFIX}: again"
    state.settle_root(connection, GEN, "folder", "folder-a", enumerated=True)
    listed = _obligation(state, connection, "folder-a")
    assert listed.status == "bound" and listed.detail is None

    # A relocation and a verified not-found are the other transitions that discharge the debt.
    state.mark_root_deferred(connection, GEN, "folder", "folder-r", DRIVE, detail="withheld")
    state.mark_root_relocating(connection, GEN, "folder", "folder-r", DRIVE, destination="shared-b")
    state.mark_root_deferred(connection, GEN, "folder", "folder-u", DRIVE, detail="withheld")
    assert state.record_root_unavailable(
        connection, GEN, "folder", "folder-u", detail="selected root unavailable: gone",
    )
    assert state.deferred_roots(connection, GEN, DRIVE) == []
    assert _obligation(state, connection, "folder-r").status == "relocating"
    assert _obligation(state, connection, "folder-u").detail == "selected root unavailable: gone"
    state.close()


@pytest.mark.asyncio
async def test_change_page_uncertainty_never_lets_metadata_recovery_settle_a_deferred_folder(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    world.put("doc-a3", drive=DRIVE, parent="folder-a")
    path = str(tmp_path / "change-page.sqlite")
    state = StateStore(path)
    await _until_complete(world, state)
    assert A_DOCS | {"doc-a3"} <= set(world.reconciled[-1])
    last_success = world.stream(DRIVE).get("last_success_at")
    reconciled = len(world.reconciled)

    # Folder A is deferred (a 503 naming no minimum) during a controlled rescan its sibling keeps open;
    # the rescan then publishes with A's retained membership only. Nothing is reconciled meanwhile.
    world.logs.setdefault(DRIVE, []).append({"fileId": "folder-b0", "file": dict(world.files["folder-b0"])})
    world.unreadable["folder-a"] = real_deferral(503)
    progress = None
    for _ in range(12):
        await world.run(state)
        progress = state.get_progress(world.namespace(DRIVE))
        if progress.building_snapshot is None and _deferred(state, world):
            break
    assert progress.building_snapshot is None and _deferred(state, world)
    assert len(world.reconciled) == reconciled
    assert world.stream(DRIVE).get("last_success_at") == last_success

    # One read of A fails with an ORDINARY error — a permission 403 naming no quota reason — on the
    # change-page path: a document claimed through A is reported removed.
    world.files.pop("doc-a3")
    world.logs[DRIVE].append({"fileId": "doc-a3", "removed": True})
    world.unreadable["folder-a"] = _ProviderHttpError(403)
    summary = await world.run(state)
    assert summary.failure_categories.get("selection_root_unverified") == 1  # the change-page caller
    assert _deferred(state, world)
    assert _obligation(state, world.integration_id, "folder-a").detail.startswith(ROOT_DEFERRED_PREFIX)
    assert world.removed == [] and len(world.reconciled) == reconciled
    state.close()

    state = StateStore(path)  # restart: the marker is durable
    assert _deferred(state, world)

    # A's metadata recovers. That locates the folder; only listing its subtree settles it.
    world.unreadable.pop("folder-a")
    world.calls.clear()
    summary = None
    for _ in range(40):
        before = len(world.reconciled)
        summary = await world.run(state)
        if not _deferred(state, world):
            assert _listed(world, "folder-a") and _listed(world, "folder-a-sub"), "settled without a listing"
        for snapshot in world.reconciled[before:]:
            assert _listed(world, "folder-a") and _listed(world, "folder-a-sub"), "complete before A was listed"
            assert A_DOCS <= set(snapshot)
        if summary.authoritative_complete:
            break
        assert world.stream(DRIVE).get("last_success_at") == last_success  # not before completion
    assert summary is not None and summary.authoritative_complete
    assert not _deferred(state, world)
    for doc in A_DOCS:
        assert world.ledger.claims[doc] == {world.integration_id}  # the existing claims survive
        assert doc not in world.ledger.deleted
    # The document that really is gone leaves through the verified listing, not the placeholder.
    assert "doc-a3" not in world.reconciled[-1]
    assert (world.integration_id, "doc-a3") in world.ledger.retired
    state.close()


# ------------------------------------------------------------------------------------------------ #
# R51 post-blind F3 — a closed deferred folder answering 404 is decided by a replacement snapshot
# ------------------------------------------------------------------------------------------------ #

@pytest.mark.parametrize("child_removed", [
    pytest.param(False, id="no-per-document-change"),
    # R51 F3-A: an ambiguous `removed` for one child claimed through A — no folder tombstone — reaches
    # the change page's root read (`absence_withheld`) while A is deferred in the active snapshot.
    pytest.param(True, id="ambiguous-child-removal"),
])
@pytest.mark.asyncio
async def test_a_deferred_folder_gone_after_its_placeholder_is_decided_by_a_replacement_snapshot(
    tmp_path, monkeypatch, clock, child_removed,
):
    world = _world(monkeypatch)
    world.config["fileIds"] = ["doc-direct"]  # a direct selection beside the two folder roots
    world.put("doc-direct", drive=DRIVE)
    path = str(tmp_path / "gone.sqlite")
    state = StateStore(path)
    await _until_complete(world, state)
    assert A_DOCS | {"doc-direct", "doc-b"} <= set(world.reconciled[-1])
    world.ledger.push(_SECOND_INTEGRATION, "doc-a1")  # another connection claims one of A's documents
    last_success = world.stream(DRIVE).get("last_success_at")

    # Folder A is deferred during a controlled rescan that its sibling keeps open: its placeholder
    # closes A's traversal carrying A's retained membership.
    world.logs.setdefault(DRIVE, []).append({"fileId": "folder-b0", "file": dict(world.files["folder-b0"])})
    world.unreadable["folder-a"] = real_deferral(503)
    progress = None
    for _ in range(4):
        await world.run(state)
        progress = state.get_progress(world.namespace(DRIVE))
        if progress.building_snapshot is not None and _deferred(state, world):
            break
    assert progress.building_snapshot is not None and _deferred(state, world)
    placeholder_build = progress.building_snapshot

    # Folder A and everything under it are then gone: A's metadata answers 404. The change feed carries
    # no folder tombstone — at most an ambiguous removal of one child.
    for gone in ("folder-a", "folder-a-sub", "doc-a1", "doc-a2"):
        world.files.pop(gone)
    world.unreadable.pop("folder-a")
    if child_removed:
        world.logs[DRIVE].append({"fileId": "doc-a1", "removed": True})
    state.close()
    state = StateStore(path)  # restart
    world.calls.clear()
    summary = None
    change_page_read_root = False
    for _ in range(40):
        before = len(world.reconciled)
        mark = len(world.calls)
        summary = await world.run(state)
        calls = world.calls[mark:]
        changes_at = next((i for i, call in enumerate(calls) if call[0] == "changes"), None)
        if changes_at is not None and ("metadata", "folder-a") in calls[changes_at:]:
            # The change page read A's verified 404 while A was deferred in the active snapshot: the
            # removal is withheld and A stays deferred — that 404 does not discharge the placeholder.
            change_page_read_root = True
            assert _deferred(state, world), "a change-page 404 discharged the deferred placeholder"
        for snapshot in world.reconciled[before:]:
            assert "doc-a2" not in snapshot, "complete with folder A's stale placeholder membership"
            assert not A_DOCS & set(snapshot), "complete with folder A's stale placeholder membership"
        if summary.authoritative_complete:
            break
        assert world.stream(DRIVE).get("last_success_at") == last_success  # not before completion
    assert summary is not None and summary.authoritative_complete
    if child_removed:
        assert change_page_read_root  # the F3-A path was really exercised
        # The child leaves through the verified replacement snapshot, not a removal on the page.
        assert "doc-a1" not in world.removed

    # A controlled replacement snapshot decided A — not the build its placeholder belongs to — from
    # A's own verified not-found, and A was never listed.
    assert state.get_progress(world.namespace(DRIVE)).active_snapshot != placeholder_build
    assert ("metadata", "folder-a") in world.calls
    assert not _listed(world, "folder-a") and not _listed(world, "folder-a-sub")
    assert not _deferred(state, world)
    # Only A's unsupported membership disappeared: the direct selection and the sibling root stay.
    assert set(world.reconciled[-1]) == {doc for doc in world.files if doc.startswith("doc-")}
    assert (world.integration_id, "doc-a1") in world.ledger.retired
    assert world.ledger.claims["doc-a1"] == {_SECOND_INTEGRATION}  # another connection's claim stands
    assert "doc-a1" not in world.ledger.deleted
    assert world.ledger.claims["doc-direct"] == {world.integration_id}
    assert world.ledger.claims["doc-b"] == {world.integration_id}
    state.close()
