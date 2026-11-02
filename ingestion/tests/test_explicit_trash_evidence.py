"""Explicit document trash is verified removal evidence, apart from ambiguous absence (AIO-1167 R51 final 2).

Spec (accepted-spec AC-05/06; Astra 20:01 UTC adjudication, finding 2). Through the real coordinator
over ``_DriveWorld`` (the brain's claims modelled by ``_ClaimLedger``; the real PostgreSQL owner is
pinned in ``test/datamechanics/gdrive-audience-claims.datamechanics.test.ts``):

  * a nested document whose selected PARENT root is under a provider restriction, then explicitly
    trashed, gets a durable removal obligation carrying the trash evidence and is reconciled promptly
    through the claim-aware owner — with ZERO reads of the restricted root or the document. The
    reporting connection's claim is retired; the last claim suppresses the content; another
    connection's valid claim survives; the restriction itself is untouched;
  * the evidence survives a failed sink acknowledgment and a restart, and the replay reads nothing;
  * an unresolved selected root (an unknown roster) and a restriction on the document itself do not
    send verified trash back to a probe;
  * an ambiguous ``removed`` hint under the restricted parent is NOT trash evidence: it stays on the
    absence gates, nothing is removed and nothing is read.
"""

from __future__ import annotations

import json

import pytest

from aios_ingest.brain_client import BrainError
from aios_ingest.state import StateStore
from test_document_restrictions import GEN, clock, run  # noqa: F401 (clock is a fixture)
from test_gdrive_upgrade import _ClaimLedger, _DriveWorld, _ProviderHttpError

FAR = "2999-01-01T00:00:00+00:00"
DRIVE = "shared-a"
RESTRICTED_READS = {("metadata", "folder-r"), ("list", DRIVE, "folder-r"), ("list", DRIVE, "folder-n")}


def _nested_world(monkeypatch, *, file_ids=()):
    world = _DriveWorld(file_ids=list(file_ids), folder_ids=["folder-r"]).install(monkeypatch)
    world.ledger = _ClaimLedger()
    world.put("folder-r", drive=DRIVE, folder=True)
    world.put("folder-n", drive=DRIVE, parent="folder-r", folder=True)
    world.put("doc-n", drive=DRIVE, parent="folder-n")
    world.put("doc-d", drive=DRIVE, parent="folder-r")
    return world


def _restrict(state, world, resource):
    state.restrict_document(world.integration_id, GEN, "account", resource, FAR, "provider_unavailable")


def _trash(world, doc):
    world.files[doc]["trashed"] = True
    world.logs.setdefault(DRIVE, []).append({"fileId": doc, "file": dict(world.files[doc])})


def _reads_of(world, doc):
    return [call for call in world.calls if call in (("metadata", doc), ("doc", doc))]


def _owed_removal_payload(state, world, doc):
    row = state._db.execute(
        "SELECT payload FROM pending_work WHERE namespace=? AND generation=? AND item_key=? "
        "AND action='remove' AND acknowledged_at IS NULL AND superseded_at IS NULL",
        (world.namespace(DRIVE), GEN, doc),
    ).fetchone()
    return None if row is None else json.loads(row[0])


@pytest.mark.parametrize("other_claim", [False, True], ids=["last-claim", "overlap"])
@pytest.mark.asyncio
async def test_explicit_trash_under_a_restricted_parent_is_reconciled_without_a_read(
    tmp_path, monkeypatch, clock, other_claim,
):
    world = _nested_world(monkeypatch)
    if other_claim:
        world.ledger.push("another-connection", "doc-n")
    state = StateStore(str(tmp_path / f"parent-{other_claim}.sqlite"))
    assert (await run(world, state)).authoritative_complete is True
    _restrict(state, world, "folder-r")

    _trash(world, "doc-n")
    world.calls.clear()
    world.pushed.clear()
    await run(world, state)

    assert not RESTRICTED_READS & set(world.calls)  # the restricted root is never read
    assert _reads_of(world, "doc-n") == []  # nor the document
    assert "doc-n" in world.removed  # reconciled promptly through the claim-aware owner
    assert (world.integration_id, "doc-n") in world.ledger.retired
    if other_claim:
        assert world.ledger.claims["doc-n"] == {"another-connection"}  # a valid claim survives
        assert "doc-n" not in world.ledger.deleted
    else:
        assert "doc-n" in world.ledger.deleted  # the last claim: the content is suppressed
    assert "doc-n" not in world.pushed  # nothing restored
    assert "folder-r" in state.document_restrictions(world.integration_id, GEN, "account")
    assert "doc-d" not in world.removed  # the parent's other content is untouched
    state.close()


@pytest.mark.asyncio
async def test_trash_evidence_survives_a_failed_sink_acknowledgment_and_a_restart(tmp_path, monkeypatch, clock):
    from datetime import timedelta

    world = _nested_world(monkeypatch)
    path = str(tmp_path / "sink-failure.sqlite")
    state = StateStore(path)
    assert (await run(world, state)).authoritative_complete is True
    _restrict(state, world, "folder-r")
    _trash(world, "doc-n")
    world.removal_faults = [BrainError(503, "server_error", "sink unavailable")]

    await run(world, state)

    assert "doc-n" not in world.removed
    payload = _owed_removal_payload(state, world, "doc-n")
    assert payload is not None and payload.get("trashed") is True  # the evidence is durable
    state.close()

    state = StateStore(path)  # restart
    clock.at += timedelta(minutes=1)
    world.calls.clear()
    await run(world, state)
    assert "doc-n" in world.removed
    assert not RESTRICTED_READS & set(world.calls) and _reads_of(world, "doc-n") == []
    assert _owed_removal_payload(state, world, "doc-n") is None
    state.close()


@pytest.mark.parametrize("restrict_document", [False, True], ids=["unknown-roster", "document-restricted"])
@pytest.mark.asyncio
async def test_an_unknown_roster_or_a_document_restriction_never_sends_trash_back_to_a_probe(
    tmp_path, monkeypatch, clock, restrict_document,
):
    # A selected root that never resolved leaves the roster unknown: an ambiguous removal would need
    # a probe of the document itself — verified trash does not.
    world = _nested_world(monkeypatch, file_ids=["file-u"])
    world.unreadable["file-u"] = _ProviderHttpError(404)
    state = StateStore(str(tmp_path / f"peer-{restrict_document}.sqlite"))
    await run(world, state)
    assert "doc-d" in world.pushed
    if restrict_document:
        _restrict(state, world, "doc-d")

    _trash(world, "doc-d")
    world.calls.clear()
    await run(world, state)

    assert _reads_of(world, "doc-d") == []
    assert "doc-d" in world.removed
    assert (world.integration_id, "doc-d") in world.ledger.retired
    state.close()


@pytest.mark.asyncio
async def test_an_ambiguous_removed_hint_under_a_restricted_parent_is_not_trash_evidence(
    tmp_path, monkeypatch, clock,
):
    world = _nested_world(monkeypatch)
    state = StateStore(str(tmp_path / "ambiguous.sqlite"))
    assert (await run(world, state)).authoritative_complete is True
    _restrict(state, world, "folder-r")

    # No file body: a removal, a move, or lost access — not the document's own trash.
    world.logs.setdefault(DRIVE, []).append({"fileId": "doc-n", "removed": True})
    world.calls.clear()
    await run(world, state)

    assert "doc-n" not in world.removed
    assert (world.integration_id, "doc-n") not in world.ledger.retired
    assert not RESTRICTED_READS & set(world.calls) and _reads_of(world, "doc-n") == []
    assert _owed_removal_payload(state, world, "doc-n") is None  # no trash-bearing obligation
    state.close()
