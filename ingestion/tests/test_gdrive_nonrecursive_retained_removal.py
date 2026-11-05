"""AIO-1167 R79 — a NONRECURSIVE selected folder selects only its immediate children, in retained-removal
verification too.

Spec (Astra R79 adjudication, accepted P1). The baseline enumeration respects each folder root's
``recursive`` flag: a nonrecursive root ``folder-a`` lists its direct children and never descends into
a child folder. A document ``doc-1`` moved from directly under ``folder-a`` into its child folder
``sub`` therefore LEFT the selection, and the removal that move produces is genuine. The retained-removal
verdict (``_selecting_stream``) must judge selection the same way: a nonrecursive folder matches only
as the document's immediate parent, a recursive folder at any depth, and the walk continues past a
nonrecursive ancestor so a recursive root further up still matches. Through the real coordinator over
``_DriveWorld`` with REPLACEMENT execution fences:

  1. nonrecursive ``folder-a`` and a blocked peer stream B: the move-into-``sub`` removal is withheld
     behind B (obligation + barrier). A replacement execution re-verifies it — ``doc-1`` is readable,
     its chain is ``sub`` → ``folder-a``, but ``folder-a`` is nonrecursive — so the removal and its
     barrier stay owed (never superseded); once B recovers, the claim retires;
  2. a direct-child restoration under nonrecursive ``folder-a`` still supersedes the obsolete removal;
  3. a descendant restoration under a RECURSIVE ``folder-a`` still supersedes it;
  4. a descendant under nonrecursive ``folder-a`` has no selecting stream, with peer-root controls (a
     direct child of B's nonrecursive root selects B, a grandchild does not unless B's root is
     recursive) and a recursive root above a nonrecursive one still matching.
"""

from __future__ import annotations

import pytest

from aios_ingest import gdrive_sync
from aios_ingest.state import StateStore
from test_gdrive_cross_stream_trash import GEN, _block_b, _coalesce, _world
from test_gdrive_upgrade import _WORLD_INTEGRATION, _owed, _retry_at

_A, _B = "shared-a", "shared-b"


def _owed_removal(state, world):
    return [row for row in _owed(state, world.namespace(_A)) if row[:2] == ("doc-1", "remove")]


def _barrier_peers(state, world):
    return [row[0] for row in state._db.execute(
        "SELECT peer_drive_id FROM removal_barriers WHERE namespace=? AND item_key='doc-1' ORDER BY peer_drive_id",
        (world.namespace(_A),),
    ).fetchall()]


async def _imported(tmp_path, monkeypatch, *, recursive: bool):
    """doc-1 imported as a DIRECT child of selected ``folder-a``; ``sub`` is a child folder of it."""
    world = _world(monkeypatch, fences=[])  # every run is a replacement execution fence
    world.config["recursive"] = recursive
    world.put("sub", drive=_A, parent="folder-a", folder=True)
    world.put("elsewhere", drive=_A, folder=True)  # an unselected folder of the same drive
    state = StateStore(str(tmp_path / "w.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    assert _WORLD_INTEGRATION in world.ledger.claims["doc-1"]
    return world, state


async def _withheld_removal(world, state, *, to: str):
    """doc-1 leaves the selection (moved to ``to``) while peer B is blocked: the removal is withheld
    behind B — owed, with B's barrier — under THIS execution's observation."""
    world.files["doc-1"]["parents"] = [to]
    _coalesce(world, _A, "doc-1", {"fileId": "doc-1", "file": dict(world.files["doc-1"])})
    _block_b(world)
    await world.run(state)
    assert gdrive_sync._cannot_read(state.get_progress(world.namespace(_B))), "B is blocked"
    assert _owed_removal(state, world), "the removal is owed"
    assert _B in _barrier_peers(state, world), "withheld behind B's barrier"
    assert "doc-1" not in world.removed and _WORLD_INTEGRATION in world.ledger.claims["doc-1"]


async def _replacement_rerun(world, state):
    _retry_at(state, world.namespace(_A), "doc-1", None)
    world.calls.clear()
    await world.run(state)


@pytest.mark.asyncio
async def test_a_move_into_a_child_folder_of_a_nonrecursive_root_stays_owed_until_the_peer_recovers(
    tmp_path, monkeypatch,
):
    world, state = await _imported(tmp_path, monkeypatch, recursive=False)
    await _withheld_removal(world, state, to="sub")

    for _ in range(2):  # replacement executions re-verify the retained removal
        await _replacement_rerun(world, state)
        assert ("metadata", "doc-1") in world.calls, "current provider evidence is read"
        assert ("metadata", "sub") in world.calls, "the current parent chain is walked"
        assert _owed_removal(state, world), "never superseded: sub is not selected by a nonrecursive root"
        assert _B in _barrier_peers(state, world), "the barrier is kept"
        assert "doc-1" not in world.removed, "still withheld behind the blocked peer"
        assert _WORLD_INTEGRATION in world.ledger.claims["doc-1"]

    # B recovers: its drain passes the barrier and the genuine removal retires this connection's claim.
    world.token_errors.pop(_B)
    for _ in range(4):
        _retry_at(state, world.namespace(_A), "doc-1", None)
        await world.run(state)
    assert "doc-1" in world.removed
    assert _WORLD_INTEGRATION not in world.ledger.claims["doc-1"], "the stale claim retires"
    assert _owed_removal(state, world) == [] and _barrier_peers(state, world) == []
    state.close()


@pytest.mark.parametrize(
    ("recursive", "restored_under"),
    [(False, "folder-a"), (True, "sub")],
    ids=["direct-child-of-nonrecursive", "descendant-of-recursive"],
)
@pytest.mark.asyncio
async def test_a_restoration_the_root_selects_supersedes_the_obsolete_removal(
    tmp_path, monkeypatch, recursive, restored_under,
):
    world, state = await _imported(tmp_path, monkeypatch, recursive=recursive)
    await _withheld_removal(world, state, to="elsewhere")
    removed, pushed = list(world.removed), world.pushed.count("doc-1")

    # Restored where the root selects it — no change row this worker has read: only the provider's
    # CURRENT parent chain proves it.
    world.files["doc-1"]["parents"] = [restored_under]
    await _replacement_rerun(world, state)

    assert ("metadata", "doc-1") in world.calls
    assert _owed_removal(state, world) == [], "the obsolete removal is superseded"
    assert _barrier_peers(state, world) == [], "its barrier goes with it"
    assert world.removed == removed and _WORLD_INTEGRATION in world.ledger.claims["doc-1"]
    assert world.pushed.count("doc-1") == pushed
    state.close()


@pytest.mark.asyncio
async def test_selecting_stream_honours_each_folder_roots_recursion(tmp_path, monkeypatch):
    world, state = await _imported(tmp_path, monkeypatch, recursive=False)
    await _withheld_removal(world, state, to="sub")
    world.put("sub-b", drive=_B, parent="folder-b", folder=True)
    world.put("top", drive=_A, folder=True)
    (work,) = [w for w in state.list_pending(world.namespace(_A), GEN) if w.item_key == "doc-1"]
    source = gdrive_sync.GoogleDriveSource()

    def selecting(*parents, drive=_A):
        meta = {**world.files["doc-1"], "driveId": drive, "parents": list(parents)}
        return gdrive_sync._selecting_stream(state, source, work, meta, _WORLD_INTEGRATION)

    def set_recursive(drive, root, value):
        state._db.execute(
            "UPDATE selection_roots SET recursive=? WHERE namespace=? AND root_kind='folder' AND root_id=?",
            (int(value), world.namespace(drive), root),
        )
        state._db.commit()

    # A descendant of nonrecursive folder-a: no stream selects it.
    assert selecting("sub") is None
    # Controls: a direct child of folder-a; a direct child of B's nonrecursive root; a grandchild of it.
    assert selecting("folder-a") == world.namespace(_A)
    assert selecting("folder-b", drive=_B) == world.namespace(_B)
    assert selecting("sub-b", drive=_B) is None
    set_recursive(_B, "folder-b", True)
    assert selecting("sub-b", drive=_B) == world.namespace(_B), "a recursive peer root selects descendants"

    # The walk continues past a nonrecursive ancestor: a recursive root further up still selects.
    world.files["folder-a"]["parents"] = ["top"]
    assert selecting("sub") is None, "top is not a root yet"
    snapshot = state.work_snapshot_id(work)
    state._db.execute(
        "INSERT INTO selection_roots(namespace,generation,snapshot_id,root_id,root_kind,drive_id,recursive) "
        "VALUES(?,?,?,?,?,?,1)", (world.namespace(_A), GEN, snapshot, "top", "folder", _A),
    )
    state._db.commit()
    assert selecting("sub") == world.namespace(_A)
    state.close()
