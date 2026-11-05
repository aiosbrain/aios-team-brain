"""AIO-1167 R98 — the drain decides membership on the CERTIFIED observation, never on the pre-read.

The coordinator reads a document's metadata (T1), checks it is selected, then extracts. If the
document changes during extraction, the reader certifies the newer observation (T2) — and the body it
pushes is T2's. Every metadata decision must then be made again on T2: current selection, the
retained-upsert ancestry proof during recovery, and selected-root restoration. Through the real
coordinator over ``_DriveWorld`` (a source whose ``_certified_raw_doc`` lets the document change
mid-read):

  * a document moved out of the selected folder during extraction is not pushed: no claim refresh, no
    acknowledgement, the obligation stays owed, and nothing is inferred deleted;
  * controls: a stable document and a stable T2 still inside the selection are pushed; an explicitly
    selected file stays selected wherever it moves;
  * a retained upsert whose ancestor left the selection during extraction is held pending;
  * a restored file root that moved drives during extraction is not settled "restored here".
"""

from __future__ import annotations

import pytest

from aios_ingest import gdrive_sync
from aios_ingest.sources.gdrive import CertifiedDocument
from aios_ingest.state import StateStore
from test_bound_root_loss import DETAIL, _binding
from test_document_restrictions import clock  # noqa: F401 (a fixture)
from test_gdrive_retained_recovery import _owed_upsert, _w1_reacquires, _w1_retains_upsert, _w2
from test_gdrive_upgrade import _ClaimLedger, _DriveWorld, _owed
from test_root_evidence_r49 import _file_world, _lose_file_x


def _certify(monkeypatch, world, during: dict | None = None) -> None:
    """Give the installed source a certifying reader: extraction runs, then ``during[id]`` (once)
    changes the document under the read, and the result carries the CURRENT snapshot — T2."""
    pending = dict(during or {})

    def certified(self, meta):
        doc = self._raw_doc(meta)
        change = pending.pop(meta["id"], None)
        if change is not None:
            change()
        return CertifiedDocument(doc=doc, metadata=dict(world.files[meta["id"]]))

    monkeypatch.setattr(gdrive_sync.GoogleDriveSource, "_certified_raw_doc", certified, raising=False)


def _folder_world(monkeypatch):
    world = _DriveWorld(folder_ids=["folder-a"]).install(monkeypatch)
    world.ledger = _ClaimLedger()
    world.put("folder-a", drive="shared-a", folder=True)
    world.put("elsewhere", drive="shared-a", folder=True)  # not selected
    world.put("doc-1", drive="shared-a", parent="folder-a")
    return world


def _edit(world, file_id, drive="shared-a"):
    world.files[file_id]["modifiedTime"] = "2026-10-01T00:00:00Z"
    world.logs.setdefault(drive, []).append({"fileId": file_id, "file": dict(world.files[file_id])})


@pytest.mark.asyncio
async def test_a_document_moved_out_of_the_selection_during_extraction_is_not_pushed(tmp_path, monkeypatch):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / "moved-out.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    _edit(world, "doc-1")
    _certify(monkeypatch, world, {
        "doc-1": lambda: world.files["doc-1"].update(parents=["elsewhere"], modifiedTime="2026-10-02T00:00:00Z"),
    })
    pushed, removed = world.pushed.count("doc-1"), list(world.removed)

    summary = await world.run(state)

    assert world.pushed.count("doc-1") == pushed, "T2's body is never pushed: no claim refresh"
    assert summary.failure_categories.get("membership_changed") == 1
    owed = [row for row in _owed(state, world.namespace("shared-a")) if row[:2] == ("doc-1", "upsert")]
    assert len(owed) == 1, "never acknowledged: the obligation stays owed"
    assert world.removed == removed, "a refusal infers no deletion"
    state.close()


@pytest.mark.parametrize("case", ["stable", "stable-t2-still-selected"])
@pytest.mark.asyncio
async def test_controls_a_certified_document_still_in_the_selection_is_pushed(tmp_path, monkeypatch, case):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / f"{case}.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    _edit(world, "doc-1")
    during = {} if case == "stable" else {
        "doc-1": lambda: world.files["doc-1"].update(name="renamed", modifiedTime="2026-10-02T00:00:00Z"),
    }
    _certify(monkeypatch, world, during)
    pushed = world.pushed.count("doc-1")

    summary = await world.run(state)

    assert world.pushed.count("doc-1") == pushed + 1
    assert "membership_changed" not in summary.failure_categories
    assert [row for row in _owed(state, world.namespace("shared-a")) if row[0] == "doc-1"] == []
    state.close()


@pytest.mark.asyncio
async def test_control_an_explicitly_selected_file_stays_selected_when_it_moves_folders(tmp_path, monkeypatch):
    world = _DriveWorld(file_ids=["file-x"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("elsewhere", drive="shared-a", folder=True)
    state = StateStore(str(tmp_path / "explicit.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    _edit(world, "file-x")
    _certify(monkeypatch, world, {"file-x": lambda: world.files["file-x"].update(parents=["elsewhere"])})
    pushed = world.pushed.count("file-x")

    summary = await world.run(state)

    assert world.pushed.count("file-x") == pushed + 1, "the explicit file root selects it wherever it lives"
    assert "membership_changed" not in summary.failure_categories
    state.close()


@pytest.mark.parametrize("ancestor_moves", [True, False], ids=["ancestor-left-during-extraction", "control"])
@pytest.mark.asyncio
async def test_retained_recovery_ancestry_is_proven_on_the_certified_observation(
    tmp_path, monkeypatch, clock, ancestor_moves,
):
    world, w1_path, w2_path = await _w1_retains_upsert(tmp_path, monkeypatch)
    await _w2(world, w2_path, move_ancestor_out=False)
    pushed = world.pushed.count("doc-1")
    w1 = await _w1_reacquires(world, w1_path, clock)
    # The pre-read ancestry proves doc-1 selected; during extraction its ancestor `sub` leaves.
    _certify(monkeypatch, world, {
        "doc-1": lambda: world.files["sub"].update(parents=["elsewhere"]),
    } if ancestor_moves else {})

    summary = await world.run(w1)

    if ancestor_moves:
        assert world.pushed.count("doc-1") == pushed, "the certified observation is no longer selected"
        assert summary.failure_categories.get("selection_unverified") == 1
        assert len(_owed_upsert(w1, world)) == 1, "kept pending, never discarded"
    else:
        assert world.pushed.count("doc-1") == pushed + 1
        assert _owed_upsert(w1, world) == []
    w1.close()


@pytest.mark.parametrize("moves_drive", [True, False], ids=["moved-drive-during-extraction", "control"])
@pytest.mark.asyncio
async def test_root_restoration_is_decided_on_the_certified_observation(tmp_path, monkeypatch, moves_drive):
    world = _file_world(monkeypatch)
    state = StateStore(str(tmp_path / "restoration.sqlite"))
    await _lose_file_x(world, state)
    world.put("file-x", drive="shared-a")
    world.logs["shared-a"].append({"fileId": "file-x", "file": dict(world.files["file-x"])})
    # Fresh pre-read: file-x is back in its bound drive. During extraction it moves to shared-b.
    _certify(monkeypatch, world, {
        "file-x": lambda: world.files["file-x"].update(driveId="shared-b", parents=["shared-b"]),
    } if moves_drive else {})
    world.pushed.clear()

    await world.run(state)

    binding = _binding(state, world, "file", "file-x")
    if moves_drive:
        assert DETAIL in (binding.detail or ""), "never settled as restored in a drive it is not in"
    else:
        assert "file-x" in world.pushed
        assert binding.status == "bound" and not binding.detail
    state.close()


# ── AIO-1167 R99: the CLOSING proof of folder-derived authority is a fresh ancestry walk ────────────
#
# Selected root R (recursive) contains folder A contains document D. While D is extracted, only A moves
# beneath an unselected folder X: D's id, version, immediate parent and certified metadata are all
# unchanged, and the stored traversal still says A is under R. Certifying D's own metadata does not
# certify the ancestry that grants its authority, so the closing proof walks it fresh — for ordinary
# current-execution work, not only for retained recovery work.


def _nested_world(monkeypatch, *, explicit_file: bool = False):
    world = _DriveWorld(
        folder_ids=["root-r"], file_ids=["doc-d"] if explicit_file else (),
    ).install(monkeypatch)
    world.ledger = _ClaimLedger()
    world.put("root-r", drive="shared-a", folder=True)
    world.put("folder-a", drive="shared-a", parent="root-r", folder=True)
    world.put("folder-x", drive="shared-a", folder=True)  # not selected
    world.put("doc-d", drive="shared-a", parent="folder-a")
    return world


def _owed_doc_d(state, world):
    return [row for row in _owed(state, world.namespace("shared-a")) if row[:2] == ("doc-d", "upsert")]


def _move_a_beneath_x(world):
    return {"doc-d": lambda: world.files["folder-a"].update(parents=["folder-x"])}


@pytest.mark.asyncio
async def test_an_ancestor_leaving_the_selection_during_extraction_withholds_ordinary_work(tmp_path, monkeypatch):
    world = _nested_world(monkeypatch)
    state = StateStore(str(tmp_path / "ancestor-left.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    assert state.get_progress(world.namespace("shared-a")).recovery_required is False
    _edit(world, "doc-d")
    certified_before = dict(world.files["doc-d"])
    _certify(monkeypatch, world, _move_a_beneath_x(world))
    pushed, removed = world.pushed.count("doc-d"), list(world.removed)
    claims = set(world.ledger.claims["doc-d"])

    summary = await world.run(state)

    assert world.files["doc-d"] == certified_before, "D itself never changed: only its ancestor moved"
    assert world.pushed.count("doc-d") == pushed, "no push, so no claim refresh"
    assert world.ledger.claims["doc-d"] == claims
    assert len(_owed_doc_d(state, world)) == 1, "the revision is not acknowledged; it stays owed"
    assert world.removed == removed, "no deletion is inferred from the withheld proof"
    assert summary.failure_categories.get("selection_unverified") == 1
    assert summary.authoritative_complete is False
    state.close()


@pytest.mark.asyncio
async def test_control_a_stable_nested_document_is_proven_fresh_then_pushed_once(tmp_path, monkeypatch):
    world = _nested_world(monkeypatch)
    state = StateStore(str(tmp_path / "nested-stable.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    _edit(world, "doc-d")
    _certify(monkeypatch, world)
    pushed = world.pushed.count("doc-d")
    world.calls.clear()

    summary = await world.run(state)

    extracted = world.calls.index(("doc", "doc-d"))
    assert ("metadata", "folder-a") in world.calls[extracted + 1:], "the closing ancestry is read fresh"
    assert world.pushed.count("doc-d") == pushed + 1
    assert _owed_doc_d(state, world) == []
    assert "selection_unverified" not in summary.failure_categories
    assert summary.authoritative_complete is True
    state.close()


@pytest.mark.asyncio
async def test_control_an_explicit_file_root_keeps_its_authority_when_its_ancestor_leaves(tmp_path, monkeypatch):
    world = _nested_world(monkeypatch, explicit_file=True)
    state = StateStore(str(tmp_path / "nested-explicit.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    _edit(world, "doc-d")
    _certify(monkeypatch, world, _move_a_beneath_x(world))
    pushed = world.pushed.count("doc-d")

    summary = await world.run(state)

    assert world.pushed.count("doc-d") == pushed + 1, "selected directly: no ancestry needed"
    assert _owed_doc_d(state, world) == []
    assert "selection_unverified" not in summary.failure_categories
    state.close()


# ── AIO-1167 R100: the closing proof has no depth cutoff — baseline enumeration has none ─────────────

def _chain_world(monkeypatch, depth: int, documents: dict[str, int]):
    """Selected recursive root ``root-r`` with a single folder chain f1 … f<depth-1> beneath it, and each
    document at its own PARENT DISTANCE from the root (distance n: n parent edges to ``root-r``)."""
    world = _DriveWorld(folder_ids=["root-r"]).install(monkeypatch)
    world.ledger = _ClaimLedger()
    world.put("root-r", drive="shared-a", folder=True)
    world.put("folder-x", drive="shared-a", folder=True)  # not selected
    for level in range(1, depth):
        world.put(f"f{level}", drive="shared-a", parent="root-r" if level == 1 else f"f{level - 1}", folder=True)
    for doc_id, distance in documents.items():
        world.put(doc_id, drive="shared-a", parent="root-r" if distance == 1 else f"f{distance - 1}")
    return world


async def _until_complete(world, state, runs: int = 8):
    """Run the coordinator until it reports authoritative completion; return every run's categories."""
    categories: dict[str, int] = {}
    for _ in range(runs):
        summary = await world.run(state)
        for key, value in (summary.failure_categories or {}).items():
            categories[key] = categories.get(key, 0) + value
        if summary.authoritative_complete:
            return summary, categories
    return summary, categories


@pytest.mark.asyncio
async def test_documents_at_any_depth_below_a_recursive_root_are_proven_pushed_once_and_complete(tmp_path, monkeypatch):
    documents = {"doc-12": 12, "doc-13": 13, "doc-40": 40}
    world = _chain_world(monkeypatch, 40, documents)
    _certify(monkeypatch, world)  # the certifying reader: every push goes through the closing proof
    state = StateStore(str(tmp_path / "deep.sqlite"))

    summary, categories = await _until_complete(world, state)

    assert summary.authoritative_complete is True
    assert "selection_unverified" not in categories
    for doc_id in documents:
        assert world.pushed.count(doc_id) == 1, doc_id
    assert [row for row in _owed(state, world.namespace("shared-a")) if row[0] in documents] == []
    # A replay pushes nothing again.
    replay = await world.run(state)
    assert replay.authoritative_complete is True
    for doc_id in documents:
        assert world.pushed.count(doc_id) == 1, doc_id
    state.close()


@pytest.mark.asyncio
async def test_a_deep_ancestor_leaving_the_selection_during_extraction_withholds_the_update(tmp_path, monkeypatch):
    world = _chain_world(monkeypatch, 20, {"doc-deep": 20})
    _certify(monkeypatch, world)
    state = StateStore(str(tmp_path / "deep-move.sqlite"))
    summary, _ = await _until_complete(world, state)
    assert summary.authoritative_complete is True and world.pushed.count("doc-deep") == 1
    _edit(world, "doc-deep")
    certified_before = dict(world.files["doc-deep"])
    _certify(monkeypatch, world, {"doc-deep": lambda: world.files["f10"].update(parents=["folder-x"])})
    claims, removed = set(world.ledger.claims["doc-deep"]), list(world.removed)

    summary = await world.run(state)

    assert world.files["doc-deep"] == certified_before
    assert world.pushed.count("doc-deep") == 1, "no push, so no claim refresh"
    assert world.ledger.claims["doc-deep"] == claims
    assert [row for row in _owed(state, world.namespace("shared-a")) if row[:2] == ("doc-deep", "upsert")]
    assert world.removed == removed
    assert summary.failure_categories.get("selection_unverified") == 1
    assert summary.authoritative_complete is False
    state.close()


@pytest.mark.asyncio
async def test_an_ancestry_cycle_without_a_selected_root_terminates_and_grants_nothing(tmp_path, monkeypatch):
    world = _chain_world(monkeypatch, 4, {"doc-c": 4})
    _certify(monkeypatch, world)
    state = StateStore(str(tmp_path / "cycle.sqlite"))
    summary, _ = await _until_complete(world, state)
    assert summary.authoritative_complete is True and world.pushed.count("doc-c") == 1
    _edit(world, "doc-c")
    # During extraction f1 is re-parented under f3: f3 → f2 → f1 → f3 … and root-r is no longer reached.
    _certify(monkeypatch, world, {"doc-c": lambda: world.files["f1"].update(parents=["f3"])})
    world.calls.clear()

    summary = await world.run(state)

    extracted = world.calls.index(("doc", "doc-c"))
    closing_reads = [call for call in world.calls[extracted + 1:] if call[0] == "metadata"]
    assert sorted(set(closing_reads)) == [("metadata", "f1"), ("metadata", "f2"), ("metadata", "f3")]
    assert len(closing_reads) == 3, "each distinct ancestor is read once: the cycle terminates"
    assert world.pushed.count("doc-c") == 1, "the cycle grants no authority"
    assert summary.failure_categories.get("selection_unverified") == 1
    assert [row for row in _owed(state, world.namespace("shared-a")) if row[:2] == ("doc-c", "upsert")]
    state.close()
