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


# ------------------------------------------------------------------------------------------------ #
# AIO-1167 final review A1 — explicit trash after LOCAL MEMBERSHIP LOSS (fresh-state recovery)
# ------------------------------------------------------------------------------------------------ #

def _acknowledged_restriction(world, resource, until=FAR):
    """A provider minimum the brain already acknowledged for this account (adopted by a fresh store)."""
    world.progress["document_restrictions"] = {
        "generation": GEN, "credential": "account",
        "items": [{"id": resource, "not_before": until, "category": "provider_unavailable", "unrepresentable": False}],
    }


async def _recover_fresh_behind_restricted_parent(tmp_path, world, name, until=FAR):
    """Import and keep the brain's claims, then recover with a NEW SQLite store while the selected
    parent folder is restricted: the stream holds no local membership for its documents."""
    first = StateStore(str(tmp_path / f"{name}-first.sqlite"))
    assert (await run(world, first)).authoritative_complete is True
    first.close()
    _acknowledged_restriction(world, "folder-r", until)
    path = str(tmp_path / f"{name}-fresh.sqlite")
    fresh = StateStore(path)
    world.calls.clear()
    for _ in range(2):
        await run(world, fresh)
    assert not RESTRICTED_READS & set(world.calls)
    assert "doc-n" not in fresh.membership_ids(world.namespace(DRIVE), GEN)  # nothing invented
    return path, fresh


@pytest.mark.parametrize("other_claim", [False, True], ids=["last-claim", "second-connection-claim"])
@pytest.mark.asyncio
async def test_explicit_trash_with_no_local_membership_is_still_reconciled_without_a_read(
    tmp_path, monkeypatch, clock, other_claim,
):
    world = _nested_world(monkeypatch)
    if other_claim:
        world.ledger.push("another-connection", "doc-n")
    _path, state = await _recover_fresh_behind_restricted_parent(tmp_path, world, f"a1-{other_claim}")
    reconciled = list(world.reconciled)
    last_success = world.stream(DRIVE).get("last_success_at")

    _trash(world, "doc-n")
    world.calls.clear()
    outcome = await run(world, state)

    assert not RESTRICTED_READS & set(world.calls) and _reads_of(world, "doc-n") == []
    assert "doc-n" in world.removed
    assert (world.integration_id, "doc-n") in world.ledger.retired
    if other_claim:
        assert world.ledger.claims["doc-n"] == {"another-connection"}
        assert "doc-n" not in world.ledger.deleted
    else:
        assert "doc-n" in world.ledger.deleted
    # Root recovery is still owed: the run stays partial and no complete success is recorded.
    assert outcome.authoritative_complete is False
    assert world.reconciled == reconciled
    assert world.stream(DRIVE).get("last_success_at") == last_success
    assert "doc-d" not in world.removed
    state.close()


@pytest.mark.parametrize("failure", ["sink-failure", "acknowledgment-lost"])
@pytest.mark.asyncio
async def test_membershipless_trash_evidence_survives_sink_failure_or_lost_ack_and_replays(
    tmp_path, monkeypatch, clock, failure,
):
    from datetime import timedelta

    from aios_ingest import gdrive_sync

    world = _nested_world(monkeypatch)
    path, state = await _recover_fresh_behind_restricted_parent(tmp_path, world, f"a1-{failure}")
    if failure == "sink-failure":
        world.removal_faults = [BrainError(503, "server_error", "sink unavailable")]
    else:
        # The brain applies the removal, and its answer never arrives.
        client = gdrive_sync.BrainClient
        original = client.reconcile_gdrive
        lost: list[int] = []

        async def applied_then_lost(self, execution, **kwargs):
            result = await original(self, execution, **kwargs)
            if kwargs.get("removed_provider_ids") and not lost:
                lost.append(1)
                raise BrainError(503, "server_error", "acknowledgment lost")
            return result

        monkeypatch.setattr(client, "reconcile_gdrive", applied_then_lost)
    _trash(world, "doc-n")
    await run(world, state)

    payload = _owed_removal_payload(state, world, "doc-n")
    assert payload is not None and payload.get("trashed") is True  # still owed, evidence durable
    state.close()

    state = StateStore(path)  # reopen and replay
    clock.at += timedelta(minutes=1)
    world.calls.clear()
    await run(world, state)
    assert _owed_removal_payload(state, world, "doc-n") is None  # acknowledged only now
    assert not RESTRICTED_READS & set(world.calls) and _reads_of(world, "doc-n") == []
    assert world.ledger.retired.count((world.integration_id, "doc-n")) == 1  # idempotent replay
    assert "doc-n" in world.ledger.deleted
    state.close()


@pytest.mark.asyncio
async def test_with_no_local_membership_an_ambiguous_removal_keeps_the_claim_and_stray_trash_is_harmless(
    tmp_path, monkeypatch, clock,
):
    world = _nested_world(monkeypatch)
    world.put("doc-x", drive=DRIVE)  # never selected by this connection
    world.ledger.push("another-connection", "doc-x")
    _path, state = await _recover_fresh_behind_restricted_parent(tmp_path, world, "a1-negatives")

    # An ambiguous `removed` (no file body) under the same uncertainty is not trash.
    world.logs.setdefault(DRIVE, []).append({"fileId": "doc-n", "removed": True})
    # Explicit trash of a document this connection never claimed.
    _trash(world, "doc-x")
    world.calls.clear()
    await run(world, state)

    assert _owed_removal_payload(state, world, "doc-n") is None
    assert "doc-n" not in world.removed
    assert world.ledger.claims["doc-n"] == {world.integration_id}  # the claim is retained
    assert not RESTRICTED_READS & set(world.calls) and _reads_of(world, "doc-n") == []
    # The stray trash reaches the connection-scoped owner and changes nothing there.
    assert (world.integration_id, "doc-x") not in world.ledger.retired
    assert world.ledger.claims["doc-x"] == {"another-connection"}
    assert "doc-x" not in world.ledger.deleted
    state.close()


@pytest.mark.asyncio
async def test_with_no_local_membership_trash_then_restore_in_one_page_removes_nothing(
    tmp_path, monkeypatch, clock,
):
    """Ordering (A1): a document trashed and then RESTORED within the same change page is not trash.
    With no local membership and an unreadable parent nothing would upsert it, so the earlier trash
    removal must not survive the page and suppress restored content."""
    world = _nested_world(monkeypatch)
    _path, state = await _recover_fresh_behind_restricted_parent(tmp_path, world, "a1-restore")
    _trash(world, "doc-n")
    world.files["doc-n"]["trashed"] = False  # restored — the later observation in the same page
    world.logs[DRIVE].append({"fileId": "doc-n", "file": dict(world.files["doc-n"])})
    world.calls.clear()
    await run(world, state)

    assert _owed_removal_payload(state, world, "doc-n") is None
    assert "doc-n" not in world.removed
    assert world.ledger.claims["doc-n"] == {world.integration_id}
    assert not RESTRICTED_READS & set(world.calls) and _reads_of(world, "doc-n") == []

    # A later page that trashes it again IS trash.
    _trash(world, "doc-n")
    await run(world, state)
    assert "doc-n" in world.removed
    state.close()


def _one_change_per_page(monkeypatch):
    """Drive answers one change per page, with a real next-page token — a deterministic two-page feed
    through the production page reader and cursor (``_DriveWorld`` itself returns one page)."""
    from aios_ingest import gdrive_sync
    from aios_ingest.gdrive_sync import ChangePage

    original = gdrive_sync.read_change_page

    def paged(drive, page_token, drive_id=None, provider_gate=None, request_executor=None):
        page = original(drive, page_token, drive_id, provider_gate, request_executor)
        if len(page.changes) <= 1:
            return page
        name, _, position = page_token.rpartition("@")
        return ChangePage(
            changes=page.changes[:1], next_page_token=f"{name}@{int(position) + 1}", new_start_page_token=None,
        )

    monkeypatch.setattr(gdrive_sync, "read_change_page", paged)


def _change_pages(state, world):
    return state._db.execute(
        "SELECT count(*) FROM materialized_pages WHERE namespace=? AND page_kind='changes'",
        (world.namespace(DRIVE),),
    ).fetchone()[0]


def _restore(world, doc):
    world.files[doc]["trashed"] = False
    world.logs.setdefault(DRIVE, []).append({"fileId": doc, "file": dict(world.files[doc])})


@pytest.mark.asyncio
async def test_two_pages_trash_then_restore_with_no_membership_settles_trash_then_recovers_by_relisting(
    tmp_path, monkeypatch, clock,
):
    """Page 1: explicit trash of a document with no local membership under a still-restricted root.
    Page 2: its later restore. The page-at-a-time contract settles page 1 before page 2 is read, so the
    acknowledged trash retires this connection's claim; the restore — out of scope while the root is
    unreadable — reads and upserts nothing early. The documented eventual result: once the root's
    minimum passes, its controlled rescan lists the restored document and its claim/visibility return."""
    from datetime import timedelta

    world = _nested_world(monkeypatch)
    until = (clock.at + timedelta(days=1)).isoformat()
    _path, state = await _recover_fresh_behind_restricted_parent(tmp_path, world, "a1-two-pages", until)
    _one_change_per_page(monkeypatch)
    pages_before = _change_pages(state, world)
    _trash(world, "doc-n")
    _restore(world, "doc-n")
    world.calls.clear()
    world.pushed.clear()
    await run(world, state)

    assert _change_pages(state, world) - pages_before == 2  # two durable pages, in order
    assert state.get_progress(world.namespace(DRIVE)).page_token == f"{DRIVE}@{len(world.logs[DRIVE])}"
    assert "doc-n" in world.removed  # page 1's verified trash, settled before page 2 was read
    assert world.removed.count("doc-n") == 1  # one bounded obligation, sent once
    assert _owed_removal_payload(state, world, "doc-n") is None
    assert not RESTRICTED_READS & set(world.calls) and _reads_of(world, "doc-n") == []
    assert "doc-n" not in world.pushed  # no premature read or upsert from page 2

    # Eventual recovery: the root's minimum passes and the controlled rescan relists the document.
    clock.at += timedelta(days=1, minutes=5)
    for _ in range(4):
        outcome = await run(world, state)
        if outcome.authoritative_complete:
            break
    assert ("list", DRIVE, "folder-r") in world.calls
    assert "doc-n" in world.pushed
    assert world.integration_id in world.ledger.claims["doc-n"]  # the claim (and visibility) is back
    assert outcome.authoritative_complete is True
    state.close()


@pytest.mark.parametrize("failure", ["sink-failure", "acknowledgment-lost"])
@pytest.mark.asyncio
async def test_two_pages_a_later_restore_supersedes_a_still_owed_trash_removal(
    tmp_path, monkeypatch, clock, failure,
):
    """If page 1's trash removal is still OWED when page 2's restore is read — its sink call failed, or
    its acknowledgment was lost — the restore supersedes it: the stale removal is never (re)sent, the
    first page can commit, and the cursor passes both pages."""
    from datetime import timedelta

    from aios_ingest import gdrive_sync

    world = _nested_world(monkeypatch)
    _path, state = await _recover_fresh_behind_restricted_parent(tmp_path, world, f"a1-owed-{failure}")
    _one_change_per_page(monkeypatch)
    pages_before = _change_pages(state, world)
    client = gdrive_sync.BrainClient
    original = client.reconcile_gdrive
    sent_after_restore: list[int] = []

    async def owed_until_restored(self, execution, **kwargs):
        # Page 1's removal stays OWED until page 2 (the restore) has been read and materialized.
        names = kwargs.get("removed_provider_ids") or []
        restored = _change_pages(state, world) - pages_before >= 2
        if "doc-n" in names and restored:
            sent_after_restore.append(1)
        if "doc-n" in names and not restored:
            if failure == "acknowledgment-lost":
                await original(self, execution, **kwargs)  # applied; its answer never arrives
            raise BrainError(503, "server_error", "removal not acknowledged")
        return await original(self, execution, **kwargs)

    monkeypatch.setattr(client, "reconcile_gdrive", owed_until_restored)
    _trash(world, "doc-n")
    _restore(world, "doc-n")
    for _ in range(4):
        await run(world, state)
        clock.at += timedelta(minutes=1)

    assert _change_pages(state, world) - pages_before == 2
    assert sent_after_restore == []  # the stale removal was never (re)sent after the restore
    assert _owed_removal_payload(state, world, "doc-n") is None  # superseded, not owed
    namespace = world.namespace(DRIVE)
    assert state.next_uncommitted_page(namespace, GEN) is None  # both pages could commit
    assert state.get_progress(namespace).page_token == f"{DRIVE}@{len(world.logs[DRIVE])}"
    if failure == "sink-failure":
        assert world.ledger.claims["doc-n"] == {world.integration_id}  # the claim was never retired
        assert "doc-n" not in world.removed
    assert _reads_of(world, "doc-n") == [] and "doc-n" not in world.pushed
    state.close()


@pytest.mark.asyncio
async def test_membershipless_trash_still_respects_the_durable_queue_bound(tmp_path, monkeypatch, clock):
    """Bounded materialization (A1): trash of documents with no local membership still counts against
    the stream's durable backlog bound. A page that would exceed it is not materialized — the cursor
    does not pass it and nothing is reconciled — rather than growing the queue without bound."""
    from aios_ingest.gdrive_sync import _MAX_PENDING_PER_STREAM

    world = _nested_world(monkeypatch)
    _path, state = await _recover_fresh_behind_restricted_parent(tmp_path, world, "a1-bound")
    namespace = world.namespace(DRIVE)
    cursor = state.get_progress(namespace).page_token
    for index in range(_MAX_PENDING_PER_STREAM + 1):
        doc = f"stray-{index}"
        world.put(doc, drive=DRIVE)
        _trash(world, doc)
    removed_before = list(world.removed)
    outcome = await run(world, state)

    assert outcome.failure_categories.get("queue_saturated") == 1
    assert state.get_progress(namespace).page_token == cursor  # the page was not passed
    assert world.removed == removed_before
    assert state._db.execute(
        "SELECT count(*) FROM pending_work WHERE namespace=? AND action='remove' AND acknowledged_at IS NULL",
        (namespace,),
    ).fetchone()[0] == 0
    state.close()
