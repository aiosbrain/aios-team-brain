"""AIO-1167 R67 P1-4 — ORDINARY retained removal evidence needs current verification too.

Spec (Astra R67 adjudication). R66 made retained explicit-trash obligations re-verify; the same hole
existed for every other removal: a move-out, an ambiguous `removed` hint (access loss, a move to an
unseen drive) and a root/ancestor tombstone. W1 observes one and retains it (sink refusal, or a
committed removal whose acknowledgment was lost); W2 — an independent SQLite store — restores the
document and publishes it; W1 reacquires and replays. Through the real coordinator over
``_DriveWorld`` (one brain, one claim ledger):

  * a retained removal of a document readable INSIDE this stream's current selection is superseded,
    never sent — no reconciliation, no claim retirement, no further upsert; one restored into
    ANOTHER stream ends only this stream's membership; across refusal/lost acknowledgment, deferred
    replacement enumeration, the last claim and a surviving other connection's claim;
  * controls: a genuinely current removal still removes (after the ordinary cross-stream weighing);
    an inconclusive read (5xx, 401, 403) is weighed but never concluded absent; a restricted document
    is not read; a named Retry-After records its minimum and is not probed early; an obligation
    with NO observation identity (legacy) is verified exactly like a retained one.
"""

from __future__ import annotations

import json
import shutil
from datetime import timedelta

import pytest

from aios_ingest.brain_client import BrainError
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import StateStore
from test_document_restrictions import clock  # noqa: F401 (a fixture)
from test_gdrive_cross_stream_trash import GEN, _coalesce, _world
from test_gdrive_upgrade import (
    _SECOND_INTEGRATION, _WORLD_INTEGRATION, _HELD, _ProviderHttpError, _owed, _retry_at,
)


def _owed_removal(state, world):
    return [row for row in _owed(state, world.namespace("shared-a")) if row[:2] == ("doc-1", "remove")]


def _observe(world, evidence):
    """Ordinary removal evidence in shared-a's log — never `trashed: true`."""
    world.put("elsewhere", drive="shared-a", folder=True)  # an unselected folder of the same drive
    if evidence == "ancestor":
        # The selected folder's subfolder holding doc-1 leaves the selection: an ancestor tombstone.
        world.files["sub"]["parents"] = ["elsewhere"]
        _coalesce(world, "shared-a", "sub", {"fileId": "sub", "removed": True})
        return
    if evidence == "move-out":
        world.files["doc-1"]["parents"] = ["elsewhere"]
        _coalesce(world, "shared-a", "doc-1", {"fileId": "doc-1", "file": dict(world.files["doc-1"])})
    elif evidence == "removed-hint":
        world.files["doc-1"]["parents"] = ["elsewhere"]
        _coalesce(world, "shared-a", "doc-1", {"fileId": "doc-1", "removed": True})


def _restore(world, evidence, where):
    """W2's restoration, as Drive reports it: each changed file once, in its CURRENT state."""
    if where == "same-stream":
        if evidence == "ancestor":
            # The subfolder comes back under the selected folder — a folder W1's snapshot no longer
            # traverses: only the document's CURRENT parent chain proves it is selected.
            world.files["sub"]["parents"] = ["folder-a"]
            _coalesce(world, "shared-a", "sub", {"fileId": "sub", "file": dict(world.files["sub"])})
            return
        world.files["doc-1"].update(driveId="shared-a", parents=["folder-a"])
        _coalesce(world, "shared-a", "doc-1", {"fileId": "doc-1", "file": dict(world.files["doc-1"])})
    else:
        world.files["doc-1"].update(driveId="shared-b", parents=["folder-b"])
        _coalesce(world, "shared-a", "doc-1", {"fileId": "doc-1", "removed": True})
        world.logs.setdefault("shared-b", []).append({"fileId": "doc-1", "file": dict(world.files["doc-1"])})


async def _w1_retains(tmp_path, monkeypatch, *, evidence, sink, other):
    lost = [] if sink == "lost" else None
    world = _world(monkeypatch, lost_responses=lost, fences=[])
    if evidence == "ancestor":
        world.put("sub", drive="shared-a", parent="folder-a", folder=True)
        world.files["doc-1"]["parents"] = ["sub"]
    if other == "last-claim":
        world.ledger.claims["doc-1"].discard(_SECOND_INTEGRATION)
    w1_path, w2_path = str(tmp_path / "w1.sqlite"), str(tmp_path / "w2.sqlite")
    w1 = StateStore(w1_path)
    assert (await world.run(w1)).authoritative_complete is True
    w1.close()
    shutil.copy(w1_path, w2_path)  # two workers, one acknowledged baseline
    w1 = StateStore(w1_path)
    _observe(world, evidence)
    if sink == "lost":
        lost.extend([True] * 3)
    else:
        world.removal_faults.extend([BrainError(503, "cleanup_unavailable", "refused")] * 3)
    for _ in range(3):  # until the removal has been attempted (a peer barrier may hold it a run)
        await world.run(w1)
        if world.removal_faults == [] or (lost is not None and len(lost) < 3):
            break
    owed = _owed_removal(w1, world)
    assert owed, "W1 retains the ordinary removal"
    payload = json.loads(w1._db.execute(
        "SELECT payload FROM pending_work WHERE item_key='doc-1' AND action='remove' "
        "AND acknowledged_at IS NULL AND superseded_at IS NULL").fetchone()[0])
    assert "trashed" not in payload and payload.get("observed_under"), "ordinary evidence, stamped where observed"
    world.removal_faults.clear()
    if lost is not None:
        lost.clear()
    _retry_at(w1, world.namespace("shared-a"), "doc-1", _HELD)
    w1.close()
    return world, w1_path, w2_path


async def _w2_restores(world, w2_path, evidence, where):
    _restore(world, evidence, where)
    w2 = StateStore(w2_path)
    for _ in range(4):
        await world.run(w2)
    assert _WORLD_INTEGRATION in world.ledger.claims["doc-1"], "W2's acknowledged restoration claims it"
    w2.close()


@pytest.mark.parametrize("other", ["other-connection", "last-claim"])
@pytest.mark.parametrize("sink", ["refused", "lost"])
@pytest.mark.parametrize("evidence", ["move-out", "removed-hint", "ancestor"])
@pytest.mark.asyncio
async def test_a_retained_ordinary_removal_never_retires_a_same_stream_restoration(
    tmp_path, monkeypatch, clock, evidence, sink, other,
):
    world, w1_path, w2_path = await _w1_retains(tmp_path, monkeypatch, evidence=evidence, sink=sink, other=other)
    await _w2_restores(world, w2_path, evidence, "same-stream")
    claims, retired, removed = set(world.ledger.claims["doc-1"]), list(world.ledger.retired), list(world.removed)
    pushed = world.pushed.count("doc-1")

    # W1 reacquires from its own file, its replacement enumeration held back: only retained work runs.
    w1 = StateStore(w1_path)
    minimum = (clock.at + timedelta(hours=1)).isoformat()
    for folder in ("folder-a", "folder-b"):
        w1.restrict_document(_WORLD_INTEGRATION, GEN, "account", folder, minimum, "provider_unavailable")
    _retry_at(w1, world.namespace("shared-a"), "doc-1", None)
    world.calls.clear()
    await world.run(w1)

    assert ("metadata", "doc-1") in world.calls, "current provider evidence is read first"
    assert world.removed == removed, "the stale removal never reaches reconciliation"
    assert _owed_removal(w1, world) == [], "superseded: the document is in the current selection"
    assert world.ledger.claims["doc-1"] == claims and world.ledger.retired == retired
    assert world.pushed.count("doc-1") == pushed, "the restoration stands without another upsert"
    w1.close()


@pytest.mark.parametrize("sink", ["refused", "lost"])
@pytest.mark.asyncio
async def test_a_retained_move_out_restored_into_another_stream_only_ends_this_streams_membership(
    tmp_path, monkeypatch, sink,
):
    world, w1_path, w2_path = await _w1_retains(
        tmp_path, monkeypatch, evidence="move-out", sink=sink, other="other-connection",
    )
    await _w2_restores(world, w2_path, "move-out", "another-stream")
    retired, removed = list(world.ledger.retired), list(world.removed)

    w1 = StateStore(w1_path)
    _retry_at(w1, world.namespace("shared-a"), "doc-1", None)
    for _ in range(4):
        world.calls.clear()
        await world.run(w1)
        assert world.removed == removed and world.ledger.retired == retired, "never retired, not even for a run"
    assert _owed_removal(w1, world) == []
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}
    w1.close()


@pytest.mark.parametrize(
    "provider",
    ["current-removal", "server-error", "account-auth-401", "access-403", "restricted", "retry-after", "legacy-current"],
)
@pytest.mark.asyncio
async def test_retained_ordinary_removal_controls(tmp_path, monkeypatch, clock, provider):
    world, w1_path, _w2_path = await _w1_retains(
        tmp_path, monkeypatch, evidence="move-out", sink="refused", other="other-connection",
    )
    w1 = StateStore(w1_path)  # a LATER execution, nothing restored: the move-out is genuinely current
    if provider == "server-error":
        world.unreadable["doc-1"] = _ProviderHttpError(500)
    elif provider == "account-auth-401":
        world.unreadable["doc-1"] = _ProviderHttpError(401)
    elif provider == "access-403":
        world.unreadable["doc-1"] = _ProviderHttpError(403)
    elif provider == "restricted":
        w1.restrict_document(_WORLD_INTEGRATION, GEN, "account", "doc-1",
                             (clock.at + timedelta(hours=1)).isoformat(), "provider_unavailable")
    elif provider == "retry-after":
        world.unreadable["doc-1"] = ProviderDeferred(
            "Retry-After", not_before=(clock.at + timedelta(hours=1)).isoformat(),
            category="provider_unavailable", provider_deadline=True,
        )
    elif provider == "legacy-current":
        # An obligation written before observation identities existed: verified like a retained one.
        w1._db.execute(
            "UPDATE pending_work SET payload=json_remove(payload,'$.observed_under') "
            "WHERE item_key='doc-1' AND action='remove'")
        w1._db.commit()
    _retry_at(w1, world.namespace("shared-a"), "doc-1", None)

    for _ in range(4):
        world.calls.clear()
        await world.run(w1)
        if provider == "retry-after" and _ == 0:
            assert "doc-1" in w1.document_restrictions(_WORLD_INTEGRATION, GEN, "account")
        elif provider in ("restricted", "retry-after"):
            assert ("metadata", "doc-1") not in world.calls, "no probe before the provider's minimum"
        _retry_at(w1, world.namespace("shared-a"), "doc-1", None)

    if provider in ("current-removal", "legacy-current"):
        # Verified current (readable, outside the selection), then weighed as before: removed.
        assert "doc-1" in world.removed
        assert world.ledger.claims["doc-1"] == {_SECOND_INTEGRATION}, "another connection's claim survives"
    else:
        assert "doc-1" not in world.removed, "uncertain or held evidence never concludes absence"
        assert _owed_removal(w1, world), "the obligation stays pending"
        assert _WORLD_INTEGRATION in world.ledger.claims["doc-1"]
    w1.close()
