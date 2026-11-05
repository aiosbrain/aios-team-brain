"""AIO-1167 R76 F1 — stale retained membership never restores a document during divergent-state recovery.

Spec (Astra R75 adjudication F1). W1 retains an upsert for ``doc-1`` (a document under the nested
folder ``sub`` of the selected root ``folder-a``). W2 — an independent SQLite store against the same
brain — sees ``sub`` moved OUT of the selected root and retires the connection's claim. W1 then
reacquires authority: its local state no longer matches the authority, so the stream is in recovery
and its replacement enumeration is held back. Its stale traversal still says ``sub`` is under
``folder-a``: a fresh fence is worker authority, not current selection. Through the real coordinator
over ``_DriveWorld``:

  * the retained upsert does not restore the document — no push, no claim reactivation — and stays
    pending (never discarded), with no absence purge inferred from the incomplete listing;
  * controls: a retained upsert whose document IS still selected (current ancestry) restores during
    recovery; after a verified move-back of the ancestor it restores too.
"""

from __future__ import annotations

import shutil
from datetime import timedelta

import pytest

from aios_ingest.state import StateStore
from test_document_restrictions import clock  # noqa: F401 (a fixture)
from test_gdrive_cross_stream_trash import GEN, _world
from test_gdrive_upgrade import _HELD, _WORLD_INTEGRATION, _owed, _retry_at


def _owed_upsert(state, world):
    return [row for row in _owed(state, world.namespace("shared-a")) if row[:2] == ("doc-1", "upsert")]


async def _w1_retains_upsert(tmp_path, monkeypatch):
    world = _world(monkeypatch)
    world.put("sub", drive="shared-a", parent="folder-a", folder=True)
    world.put("elsewhere", drive="shared-a", folder=True)
    world.files["doc-1"]["parents"] = ["sub"]
    w1_path, w2_path = str(tmp_path / "w1.sqlite"), str(tmp_path / "w2.sqlite")
    w1 = StateStore(w1_path)
    assert (await world.run(w1)).authoritative_complete is True
    w1.close()
    shutil.copy(w1_path, w2_path)  # two workers, one acknowledged baseline

    # W1 observes an edit but cannot extract it: the upsert is retained, owed.
    w1 = StateStore(w1_path)
    world.files["doc-1"]["modifiedTime"] = "2026-10-01T00:00:00Z"
    world.logs["shared-a"].append({"fileId": "doc-1", "file": dict(world.files["doc-1"])})
    world.malformed.add("doc-1")
    await world.run(w1)
    assert len(_owed_upsert(w1, world)) == 1
    _retry_at(w1, world.namespace("shared-a"), "doc-1", _HELD)
    world.malformed.discard("doc-1")
    w1.close()
    return world, w1_path, w2_path


async def _w2(world, w2_path, *, move_ancestor_out: bool):
    w2 = StateStore(w2_path)
    if move_ancestor_out:
        world.files["sub"]["parents"] = ["elsewhere"]
        world.logs["shared-a"].append({"fileId": "sub", "removed": True})
    else:
        world.files["doc-b"]["modifiedTime"] = "2026-10-02T00:00:00Z"  # an unrelated change
        world.logs["shared-b"].append({"fileId": "doc-b", "file": dict(world.files["doc-b"])})
    for _ in range(3):
        await world.run(w2)
    w2.close()


async def _w1_reacquires(world, w1_path, clock):
    w1 = StateStore(w1_path)
    # Its replacement enumeration is held back (a provider minimum on the selected root): the
    # retained work drains first, against the stale snapshot.
    w1.restrict_document(_WORLD_INTEGRATION, GEN, "account", "folder-a",
                         (clock.at + timedelta(hours=1)).isoformat(), "provider_unavailable")
    _retry_at(w1, world.namespace("shared-a"), "doc-1", None)
    return w1


@pytest.mark.asyncio
async def test_a_retained_upsert_never_restores_a_document_whose_ancestor_left_the_selection(tmp_path, monkeypatch, clock):
    world, w1_path, w2_path = await _w1_retains_upsert(tmp_path, monkeypatch)
    await _w2(world, w2_path, move_ancestor_out=True)
    assert _WORLD_INTEGRATION not in world.ledger.claims["doc-1"], "W2 retired the claim"
    pushed, removed = world.pushed.count("doc-1"), list(world.removed)

    w1 = await _w1_reacquires(world, w1_path, clock)
    world.calls.clear()
    summary = await world.run(w1)

    # Divergent-state recovery: W1's local checkpoint no longer matches the authority, so it captures a
    # fresh start token for a controlled rescan — and its retained work drains before that rescan.
    assert world.calls[0] == ("start", "shared-a")
    assert world.pushed.count("doc-1") == pushed, "the stale membership restored nothing"
    assert _WORLD_INTEGRATION not in world.ledger.claims["doc-1"], "the retired claim was not reactivated"
    assert len(_owed_upsert(w1, world)) == 1, "kept pending, never discarded"
    assert summary.failure_categories.get("selection_unverified") == 1
    assert world.removed == removed, "no absence purge inferred from the incomplete listing"
    assert summary.authoritative_complete is False
    w1.close()


@pytest.mark.parametrize("control", ["still-selected", "verified-move-back"])
@pytest.mark.asyncio
async def test_controls_a_retained_upsert_with_current_selected_ancestry_restores(tmp_path, monkeypatch, clock, control):
    world, w1_path, w2_path = await _w1_retains_upsert(tmp_path, monkeypatch)
    await _w2(world, w2_path, move_ancestor_out=(control == "verified-move-back"))
    if control == "verified-move-back":
        world.files["sub"]["parents"] = ["folder-a"]  # the ancestor is back under the selected root
    pushed = world.pushed.count("doc-1")

    w1 = await _w1_reacquires(world, w1_path, clock)
    world.calls.clear()
    await world.run(w1)

    assert world.calls[0] == ("start", "shared-a")  # the same divergent-state recovery
    assert world.pushed.count("doc-1") == pushed + 1, "current positive ancestry restores the document"
    assert _WORLD_INTEGRATION in world.ledger.claims["doc-1"]
    assert _owed_upsert(w1, world) == []
    w1.close()
