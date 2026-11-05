"""AIO-1167 R61 fix 1 — an older trash obligation never undoes a later restoration through another stream.

Spec (Astra R61 adjudication, finding 1). One connection selects a folder in Shared Drive A and one in
Shared Drive B. Stream A records evidence-bearing trash of ``doc-1`` and its removal is refused (or
committed with the response lost), so it stays owed. The document is then restored and moved into
B's selected folder, and B ingests it — through its change log, or through a baseline enumeration.
A's delayed retry runs before A reads the move-out. The brain's claim is one per connection, so
replaying the historical trash would deactivate the restored claim, and no later complete snapshot
reactivates it. Through the real coordinator over ``_DriveWorld`` (claims in ``_ClaimLedger``):

  * the delayed retry re-verifies against the provider and is superseded, never sent: the restored
    claim and content survive, nothing is cleaned up — across a SQLite reopen with a replacement
    execution fence, and through later complete snapshots and the cleanup drain, without another
    upsert;
  * controls: a GENUINELY later trash still removes; another connection's claim survives either
    way; a restricted document is not read early and its removal is retained until it may be.
"""

from __future__ import annotations

import dataclasses
import shutil
from datetime import timedelta

import pytest

from aios_ingest import gdrive_sync
from aios_ingest.brain_client import BrainError
from aios_ingest.state import StateStore
from test_document_restrictions import clock  # noqa: F401 (a fixture)
from test_gdrive_upgrade import (
    _HELD, _SECOND_INTEGRATION, _WORLD_INTEGRATION, _ClaimLedger, _DriveWorld, _owed, _ProviderHttpError,
    _retry_at,
)

GEN = 9


def _world(monkeypatch, *, lost_responses: list | None = None, fences: list | None = None):
    world = _DriveWorld(folder_ids=["folder-a", "folder-b"]).install(monkeypatch)
    world.ledger = _ClaimLedger()
    world.ledger.push(_SECOND_INTEGRATION, "doc-1")  # another connection's valid claim
    world.put("folder-a", drive="shared-a", folder=True)
    world.put("folder-b", drive="shared-b", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-a")
    world.put("doc-b", drive="shared-b", parent="folder-b")
    client = gdrive_sync.BrainClient
    if lost_responses is not None:
        # A removal the brain COMMITS whose response is lost: the claim is retired, the sidecar
        # never learns it, and the obligation stays owed.
        committed = client.reconcile_gdrive

        async def reconcile(self, execution, **kwargs):
            result = await committed(self, execution, **kwargs)
            if kwargs.get("removed_provider_ids") and lost_responses:
                lost_responses.pop(0)
                raise BrainError(504, "reconcile_response_lost", "no response arrived")
            return result

        monkeypatch.setattr(client, "reconcile_gdrive", reconcile)
    if fences is not None:
        # Every run is a REPLACEMENT execution: a new, higher fence.
        acquire = client.acquire_gdrive_execution

        async def acquire_next(self, requested, owner):
            execution = await acquire(self, requested, owner)
            fences.append(len(fences) + 2)
            return dataclasses.replace(execution, fence=fences[-1])

        monkeypatch.setattr(client, "acquire_gdrive_execution", acquire_next)
    return world


def _trash_in_a(world):
    world.files["doc-1"]["trashed"] = True
    world.logs.setdefault("shared-a", []).append({"fileId": "doc-1", "file": dict(world.files["doc-1"])})


def _restore_into_b(world, *, through: str):
    """Restore and move doc-1 into B's selected folder. A's log has not been read past it yet."""
    world.files["doc-1"].update(trashed=False, driveId="shared-b", parents=["folder-b"])
    if through == "changes":
        world.logs.setdefault("shared-b", []).append({"fileId": "doc-1", "file": dict(world.files["doc-1"])})
    else:
        # No change row: B owes a controlled recovery, and its baseline enumeration lists doc-1.
        world.progress["streams"]["shared-b"]["checkpoint_id"] = "page-this-sidecar-never-retired"
        world.revision += 1


def _owed_trash(state, world):
    return [row for row in _owed(state, world.namespace("shared-a")) if row[:2] == ("doc-1", "remove")]


async def _refused_trash_then_restored(tmp_path, monkeypatch, name, *, sink, through, reopen=False):
    lost = [] if sink == "lost" else None
    fences = [] if reopen else None
    world = _world(monkeypatch, lost_responses=lost, fences=fences)
    path = str(tmp_path / name)
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}

    # A observes explicit trash; its removal is refused, or committed with the response lost.
    _trash_in_a(world)
    if sink == "lost":
        lost.append(True)
    else:
        world.removal_faults.append(BrainError(503, "cleanup_unavailable", "the brain refused"))
    await world.run(state)
    assert len(_owed_trash(state, world)) == 1, "the trash obligation stays owed and retryable"
    if sink == "lost":
        assert world.ledger.claims["doc-1"] == {_SECOND_INTEGRATION}  # committed: our claim retired
    else:
        assert world.removed == [] and world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}
    _retry_at(state, world.namespace("shared-a"), "doc-1", _HELD)

    # Restored into B, which ingests it (change log or baseline enumeration) while A's retry waits.
    _restore_into_b(world, through=through)
    if reopen:
        state.close()
        state = StateStore(path)
    pushed_before = world.pushed.count("doc-1")
    await world.run(state)
    assert world.pushed.count("doc-1") == pushed_before + 1, "B ingested the restored document"
    assert _WORLD_INTEGRATION in world.ledger.claims["doc-1"], "B's push restored the connection's claim"
    assert state.claimed_elsewhere(_WORLD_INTEGRATION, GEN, world.namespace("shared-a"), "doc-1")
    assert len(_owed_trash(state, world)) == 1, "A's older trash is still owed: B could not cancel it"
    if reopen:
        state.close()
        state = StateStore(path)
    return world, path, state, fences


@pytest.mark.parametrize("through", ["changes", "baseline"])
@pytest.mark.parametrize("sink", ["refused", "lost"])
@pytest.mark.parametrize("reopen", [False, True], ids=["same-store", "reopened-replacement-fence"])
@pytest.mark.asyncio
async def test_a_delayed_trash_retry_never_undoes_a_later_restoration_through_another_stream(
    tmp_path, monkeypatch, through, sink, reopen,
):
    world, path, state, fences = await _refused_trash_then_restored(
        tmp_path, monkeypatch, f"{through}-{sink}-{reopen}.sqlite", sink=sink, through=through, reopen=reopen,
    )
    removed_before, pushed = list(world.removed), world.pushed.count("doc-1")

    # A's delayed retry comes due, and runs before A reads the move-out.
    _retry_at(state, world.namespace("shared-a"), "doc-1", None)
    world.calls.clear()
    await world.run(state)

    assert ("metadata", "doc-1") in world.calls, "the retained trash is re-verified against the later claim"
    assert world.removed == removed_before, "the obsolete trash is never sent"
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}
    assert _owed_trash(state, world) == [], "superseded, not left owed"
    if reopen:
        assert fences == sorted(set(fences)) and len(fences) >= 4  # each run a fresh, higher fence

    # A later reads the move-out; complete snapshots and the cleanup drain follow. The restoration
    # stands with no further upsert, and nothing is cleaned up.
    world.logs["shared-a"].append({"fileId": "doc-1", "removed": True})
    for _ in range(3):
        if reopen:
            state.close()
            state = StateStore(path)
        summary = await world.run(state)
    assert summary.authoritative_complete is True
    assert "doc-1" in world.reconciled[-1], "the latest complete snapshot holds the restored document"
    assert world.removed == removed_before
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}
    assert "doc-1" not in world.ledger.deleted
    assert world.pushed.count("doc-1") == pushed, "preserved without another upsert"
    assert state.membership_ids(world.namespace("shared-b"), GEN) == ["doc-1", "doc-b"]
    state.close()


@pytest.mark.asyncio
async def test_control_a_genuinely_later_trash_still_removes_and_another_connection_keeps_its_claim(
    tmp_path, monkeypatch,
):
    world, _path, state, _ = await _refused_trash_then_restored(
        tmp_path, monkeypatch, "later-trash.sqlite", sink="refused", through="changes",
    )
    # After B's restoration the document is trashed AGAIN — current provider truth.
    world.files["doc-1"]["trashed"] = True
    world.logs["shared-b"].append({"fileId": "doc-1", "file": dict(world.files["doc-1"])})
    _retry_at(state, world.namespace("shared-a"), "doc-1", None)
    await world.run(state)

    assert "doc-1" in world.removed
    assert (_WORLD_INTEGRATION, "doc-1") in world.ledger.retired
    assert world.ledger.claims["doc-1"] == {_SECOND_INTEGRATION}, "another connection's claim survives"
    assert "doc-1" not in world.ledger.deleted
    assert _owed_trash(state, world) == []
    state.close()


@pytest.mark.asyncio
async def test_control_a_prompt_trash_with_no_other_claim_is_removed_without_a_read(tmp_path, monkeypatch):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "prompt.sqlite"))
    assert (await world.run(state)).authoritative_complete is True
    _trash_in_a(world)
    world.calls.clear()
    await world.run(state)
    assert "doc-1" in world.removed
    assert ("metadata", "doc-1") not in world.calls, "current trash is removed promptly, unread (R51 final 2)"
    assert world.ledger.claims["doc-1"] == {_SECOND_INTEGRATION}
    state.close()


@pytest.mark.asyncio
async def test_control_a_restricted_document_is_not_read_early_and_its_removal_is_retained(
    tmp_path, monkeypatch, clock,
):
    world, _path, state, _ = await _refused_trash_then_restored(
        tmp_path, monkeypatch, "restricted.sqlite", sink="refused", through="changes",
    )
    minimum = (clock.at + timedelta(hours=1)).isoformat()
    state.restrict_document(_WORLD_INTEGRATION, GEN, "account", "doc-1", minimum, "provider_unavailable")
    _retry_at(state, world.namespace("shared-a"), "doc-1", None)
    world.calls.clear()
    held = await world.run(state)

    assert ("metadata", "doc-1") not in world.calls and ("doc", "doc-1") not in world.calls
    assert world.removed == []
    assert len(_owed_trash(state, world)) == 1, "retained, neither sent nor superseded"
    assert held.authoritative_complete is False
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}

    # The minimum passes: re-verified, superseded, and the restored claim stands.
    clock.at += timedelta(hours=2)
    _retry_at(state, world.namespace("shared-a"), "doc-1", None)
    await world.run(state)
    assert world.removed == [] and _owed_trash(state, world) == []
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}
    state.close()


# ── R62: a peer that is unreadable NOW still holds a LATER restoration's claim ──────────────────

def _block_b(world):
    """B owes a controlled recovery and its drive refuses the start token it begins with."""
    world.progress["streams"]["shared-b"]["checkpoint_id"] = "page-this-sidecar-never-retired"
    world.revision += 1
    world.token_errors["shared-b"] = _ProviderHttpError(403)


async def _restored_then_b_blocked(tmp_path, monkeypatch, name, *, sink, through):
    world, path, state, fences = await _refused_trash_then_restored(
        tmp_path, monkeypatch, name, sink=sink, through=through, reopen=True,
    )
    _block_b(world)
    blocked = await world.run(state)
    b = world.namespace("shared-b")
    peer = state.get_progress(b)
    assert gdrive_sync._cannot_read(peer), "B is start-token recovery-blocked"
    assert blocked.authoritative_complete is False
    assert "doc-1" in state.membership_ids(b, GEN, snapshot_id=peer.active_snapshot), "B's active snapshot holds it"
    assert state.streams_claiming(_WORLD_INTEGRATION, GEN, world.namespace("shared-a"), "doc-1") == [b]
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}
    assert len(_owed_trash(state, world)) == 1, "A's older trash is still owed"
    state.close()
    return world, path, StateStore(path), fences  # reopened: the next run is a replacement fence


@pytest.mark.parametrize("through", ["changes", "baseline"])
@pytest.mark.parametrize("sink", ["refused", "lost"])
@pytest.mark.asyncio
async def test_a_blocked_peers_restored_claim_is_never_retired_by_an_older_trash(
    tmp_path, monkeypatch, through, sink,
):
    world, path, state, fences = await _restored_then_b_blocked(
        tmp_path, monkeypatch, f"blocked-{through}-{sink}.sqlite", sink=sink, through=through,
    )
    removed_before, pushed = list(world.removed), world.pushed.count("doc-1")
    fence_before = fences[-1]

    _retry_at(state, world.namespace("shared-a"), "doc-1", None)
    world.calls.clear()
    await world.run(state)

    assert fences[-1] > fence_before, "a replacement execution fence"
    assert ("metadata", "doc-1") in world.calls, "stream availability is not chronology: the provider decides"
    assert world.removed == removed_before, "no removal is sent"
    assert _owed_trash(state, world) == [], "the old trash is durably superseded"
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}
    assert "doc-1" not in world.ledger.deleted
    assert world.pushed.count("doc-1") == pushed, "no extra upsert"

    # A further reopen keeps it settled — B still blocked, nothing re-sent.
    state.close()
    state = StateStore(path)
    await world.run(state)
    assert world.removed == removed_before and _owed_trash(state, world) == []
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}
    assert world.pushed.count("doc-1") == pushed
    assert gdrive_sync._cannot_read(state.get_progress(world.namespace("shared-b")))
    state.close()


@pytest.mark.asyncio
async def test_a_blocked_peer_under_a_document_restriction_reads_nothing_until_it_expires(
    tmp_path, monkeypatch, clock,
):
    world, _path, state, _ = await _restored_then_b_blocked(
        tmp_path, monkeypatch, "blocked-restricted.sqlite", sink="refused", through="changes",
    )
    minimum = (clock.at + timedelta(hours=1)).isoformat()
    state.restrict_document(_WORLD_INTEGRATION, GEN, "account", "doc-1", minimum, "provider_unavailable")
    _retry_at(state, world.namespace("shared-a"), "doc-1", None)
    world.calls.clear()
    await world.run(state)

    assert [call for call in world.calls if call in (("metadata", "doc-1"), ("doc", "doc-1"))] == []
    assert world.removed == [] and len(_owed_trash(state, world)) == 1
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}

    clock.at += timedelta(hours=2)
    _retry_at(state, world.namespace("shared-a"), "doc-1", None)
    world.calls.clear()
    await world.run(state)
    assert ("metadata", "doc-1") in world.calls
    assert world.removed == [] and _owed_trash(state, world) == []
    assert world.ledger.claims["doc-1"] == {_WORLD_INTEGRATION, _SECOND_INTEGRATION}
    state.close()


@pytest.mark.parametrize("loss", ["trashed", "deleted"])
@pytest.mark.parametrize("other", ["other-connection", "last-claim"])
@pytest.mark.asyncio
async def test_control_a_current_loss_is_still_removed_promptly_while_the_peer_is_blocked(
    tmp_path, monkeypatch, loss, other,
):
    world, _path, state, _ = await _restored_then_b_blocked(
        tmp_path, monkeypatch, f"blocked-{loss}-{other}.sqlite", sink="refused", through="changes",
    )
    if other == "last-claim":
        world.ledger.claims["doc-1"].discard(_SECOND_INTEGRATION)
    # Provider truth now: trashed again, or gone (404). B cannot read its log to say so.
    if loss == "trashed":
        world.files["doc-1"]["trashed"] = True
    else:
        del world.files["doc-1"]
    _retry_at(state, world.namespace("shared-a"), "doc-1", None)
    world.calls.clear()
    await world.run(state)

    assert ("metadata", "doc-1") in world.calls
    assert "doc-1" in world.removed, "a confirmed current loss is removed promptly"
    assert (_WORLD_INTEGRATION, "doc-1") in world.ledger.retired
    assert _owed_trash(state, world) == []
    if other == "other-connection":
        assert world.ledger.claims["doc-1"] == {_SECOND_INTEGRATION} and "doc-1" not in world.ledger.deleted
    else:
        assert "doc-1" in world.ledger.deleted, "the last claim: the content is suppressed"
    state.close()


# ── R66: retained trash vs a restoration another WORKER published through another state file ──────

def _coalesce(world, drive, doc, row):
    """Drive's change log reports a file once, in its CURRENT state: earlier rows for it are replaced."""
    log = world.logs.setdefault(drive, [])
    for index, existing in enumerate(log):
        if existing.get("fileId") == doc:
            log[index] = row
            return
    log.append(row)


async def _w1_retains_trash_w2_restores(tmp_path, monkeypatch, clock, *, sink, where, other, enumeration):
    """W1 retains A's explicit trash (refused / committed-but-lost); W2 — an independent store
    copied from the same acknowledged baseline — restores the document and publishes it."""
    lost = [] if sink == "lost" else None
    world = _world(monkeypatch, lost_responses=lost, fences=[])
    if other == "last-claim":
        world.ledger.claims["doc-1"].discard(_SECOND_INTEGRATION)
    w1_path, w2_path = str(tmp_path / "w1.sqlite"), str(tmp_path / "w2.sqlite")
    w1 = StateStore(w1_path)
    assert (await world.run(w1)).authoritative_complete is True
    w1.close()
    shutil.copy(w1_path, w2_path)
    w1 = StateStore(w1_path)

    _trash_in_a(world)
    if sink == "lost":
        lost.append(True)
    else:
        world.removal_faults.append(BrainError(503, "cleanup_unavailable", "the brain refused"))
    await world.run(w1)
    assert len(_owed_trash(w1, world)) == 1, "W1 retains the trash obligation"
    _retry_at(w1, world.namespace("shared-a"), "doc-1", _HELD)
    w1.close()

    # Restored — in place (same stream) or into B (another stream) — and W2 publishes it.
    world.files["doc-1"]["trashed"] = False
    if where == "same-stream":
        _coalesce(world, "shared-a", "doc-1", {"fileId": "doc-1", "file": dict(world.files["doc-1"])})
    else:
        world.files["doc-1"].update(driveId="shared-b", parents=["folder-b"])
        _coalesce(world, "shared-a", "doc-1", {"fileId": "doc-1", "removed": True})
        world.logs["shared-b"].append({"fileId": "doc-1", "file": dict(world.files["doc-1"])})
    pushed = world.pushed.count("doc-1")
    w2 = StateStore(w2_path)
    for _ in range(3):
        await world.run(w2)
    assert world.pushed.count("doc-1") == pushed + 1, "W2 ingested the restoration"
    assert _WORLD_INTEGRATION in world.ledger.claims["doc-1"], "W2's acknowledged restoration claims it"
    assert _owed_trash(w2, world) == [], "W2 holds no trash"
    w2.close()

    # W1 reacquires from its own state file, which knows nothing of W2's restoration.
    w1 = StateStore(w1_path)
    assert len(_owed_trash(w1, world)) == 1
    if enumeration == "deferred":
        # Its replacement enumeration is held back: only the retained work can run first.
        minimum = (clock.at + timedelta(hours=1)).isoformat()
        w1.restrict_document(_WORLD_INTEGRATION, GEN, "account", "folder-a", minimum, "provider_unavailable")
        w1.restrict_document(_WORLD_INTEGRATION, GEN, "account", "folder-b", minimum, "provider_unavailable")
    _retry_at(w1, world.namespace("shared-a"), "doc-1", None)
    return world, w1_path, w1


@pytest.mark.parametrize("enumeration", ["normal", "deferred"])
@pytest.mark.parametrize("other", ["other-connection", "last-claim"])
@pytest.mark.parametrize("where", ["same-stream", "another-stream"])
@pytest.mark.parametrize("sink", ["refused", "lost"])
@pytest.mark.asyncio
async def test_retained_trash_never_retires_a_restoration_another_worker_published(
    tmp_path, monkeypatch, clock, sink, where, other, enumeration,
):
    world, w1_path, w1 = await _w1_retains_trash_w2_restores(
        tmp_path, monkeypatch, clock, sink=sink, where=where, other=other, enumeration=enumeration,
    )
    claims = set(world.ledger.claims["doc-1"])
    removed, pushed, deleted = list(world.removed), world.pushed.count("doc-1"), list(world.ledger.deleted)
    retired = list(world.ledger.retired)
    world.calls.clear()
    await world.run(w1)

    assert ("metadata", "doc-1") in world.calls, "retained trash is re-verified against the provider"
    assert world.removed == removed, "the obsolete removal never reaches reconciliation"
    assert _owed_trash(w1, world) == [], "superseded by the readable, untrashed document"
    assert world.ledger.claims["doc-1"] == claims and world.ledger.deleted == deleted
    assert world.ledger.retired == retired, "the restored claim was never retired"
    if enumeration == "deferred":
        # Only the retained work ran: the restoration stands without another upsert. (A normal
        # replacement enumeration of W1's stale store re-reads every document it lists — doc-b too.)
        assert world.pushed.count("doc-1") == pushed, "it survived without another upsert"

    # Restarts until complete reconciliation (any restriction lapsed). W1's own recovery rescan may
    # re-read what it enumerates — doc-b as much as doc-1 — but the claim is never retired between.
    clock.at += timedelta(hours=2)
    for _ in range(6):
        w1.close()
        w1 = StateStore(w1_path)
        summary = await world.run(w1)
        if summary.authoritative_complete:
            break
    assert summary.authoritative_complete is True
    assert "doc-1" in world.reconciled[-1]
    assert world.removed == removed and world.ledger.claims["doc-1"] == claims
    assert world.ledger.deleted == deleted, "nothing suppressed since the restoration"
    assert world.ledger.retired == retired, "no complete reconciliation retired the restored claim"
    w1.close()


@pytest.mark.parametrize(
    "provider", ["trashed-again", "deleted-404", "ambiguous-500", "restricted", "retry-after"],
)
@pytest.mark.asyncio
async def test_retained_trash_replay_follows_current_provider_evidence(tmp_path, monkeypatch, clock, provider):
    from aios_ingest.sources.gdrive import ProviderDeferred

    world, w1_path, w1 = await _w1_retains_trash_w2_restores(
        tmp_path, monkeypatch, clock, sink="refused", where="another-stream", other="other-connection",
        enumeration="normal",
    )
    if provider == "trashed-again":
        world.files["doc-1"]["trashed"] = True
    elif provider == "deleted-404":
        del world.files["doc-1"]
    elif provider == "ambiguous-500":
        world.unreadable["doc-1"] = _ProviderHttpError(500)
    elif provider == "restricted":
        w1.restrict_document(
            _WORLD_INTEGRATION, GEN, "account", "doc-1", (clock.at + timedelta(hours=1)).isoformat(),
            "provider_unavailable",
        )
    else:
        world.unreadable["doc-1"] = ProviderDeferred(
            "Retry-After", not_before=(clock.at + timedelta(hours=1)).isoformat(),
            category="provider_unavailable", provider_deadline=True,
        )
    world.calls.clear()
    await world.run(w1)

    if provider in ("trashed-again", "deleted-404"):
        assert "doc-1" in world.removed, "current trash or a document 404 permits the removal"
        assert world.ledger.claims["doc-1"] == {_SECOND_INTEGRATION}, "another connection's claim survives"
        assert _owed_trash(w1, world) == []
    else:
        assert "doc-1" not in world.removed and len(_owed_trash(w1, world)) == 1, "the obligation is kept"
        assert _WORLD_INTEGRATION in world.ledger.claims["doc-1"]
        if provider == "restricted":
            assert ("metadata", "doc-1") not in world.calls, "a standing restriction prevents the probe"
        if provider == "retry-after":
            assert "doc-1" in w1.document_restrictions(_WORLD_INTEGRATION, GEN, "account")
            _retry_at(w1, world.namespace("shared-a"), "doc-1", None)
            world.calls.clear()
            await world.run(w1)  # before the named minimum passes
            assert ("metadata", "doc-1") not in world.calls, "no early probe after a Retry-After"
            assert "doc-1" not in world.removed
    w1.close()
