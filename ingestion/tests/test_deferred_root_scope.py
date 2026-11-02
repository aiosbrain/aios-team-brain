"""A deferred folder root's retained membership is admission evidence, not scope loss (AIO-1167
R51 F1), and a deferred root that keeps timing out does not relist its healthy siblings (R51 F4).

Spec (Astra R50 adjudication, findings 1 and 4). Through the real coordinator over ``_DriveWorld``,
with a recursive selected root ``folder-r`` → ``sub`` → nested documents, and a healthy sibling root
``folder-h`` in the same Shared Drive:

F1 — once a controlled rescan DEFERS ``folder-r`` (its metadata timed out, or it was under a provider
minimum), its snapshot holds the membership the published snapshot proved through it, without its
traversal. A later change to a nested document therefore has no known parent. That is NOT evidence
the document left the selection: it is held — no remove obligation, no membership drop, no sink
removal, no reconciliation — even when the root's metadata now reads present (a metadata read is not
subtree enumeration), including when the root's provider minimum lapses between the stream's
admission check and the page's classification. The root stays deferred; no rescan is started for the
held change. Independent and overlapping claims still flow; retained evidence never widens scope;
fresh state invents nothing. After a verified enumeration the nested document flows again and a
document that really moved out is reconciled away only by the complete snapshot.

F4 — before a deferred root alone starts a whole-stream rescan, ONE bounded root-local probe per run
reads its metadata: a timeout keeps the root deferred and lets the sibling's changes drain without
any listing; a provider-named minimum is recorded and then forbids probing; a quota answer is the
account's hold; once the root reads, the normal controlled rescan recovers it.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from aios_ingest.sources.gdrive import ProviderCursorInvalid, ProviderDeferred
from aios_ingest.state import StateStore
from test_document_restrictions import clock  # noqa: F401 (fixture)
from test_gdrive_upgrade import _WORLD_INTEGRATION, _DriveWorld
from test_restricted_root_recovery import _edit, _restrict
from test_root_evidence_r49 import real_deferral

GEN = 9
DEFERRED = "selected root deferred"
LONG = "99999999"


def _timeout() -> ProviderDeferred:
    return ProviderDeferred("root metadata timed out", category="provider_timeout")


class _Once(dict):
    """An injected read failure raised by the NEXT read of that id only."""

    def __getitem__(self, key):
        return super().pop(key)


class _AdvanceClockOnChangeRead(dict):
    """Advances the shared clock the first time a change page is read — after the stream's
    admission check, before the page is classified."""

    def __init__(self, clock, by):
        super().__init__()
        self.clock, self.by, self.armed = clock, by, True

    def get(self, key, default=None):
        if self.armed:
            self.armed = False
            self.clock.at += self.by
        return super().get(key, default)


def _world(monkeypatch):
    world = _DriveWorld(file_ids=["doc-o"], folder_ids=["folder-r", "folder-h"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("sub", drive="shared-a", parent="folder-r", folder=True)
    world.put("doc-n", drive="shared-a", parent="sub")
    world.put("doc-m", drive="shared-a", parent="sub")
    world.put("doc-o", drive="shared-a", parent="sub")  # also selected directly: an overlapping claim
    world.put("folder-h", drive="shared-a", folder=True)
    world.put("doc-h", drive="shared-a", parent="folder-h")
    return world


def _binding(state):
    return state.root_obligations(_WORLD_INTEGRATION, GEN).get(("folder", "folder-r"))


def _deferred(state) -> bool:
    binding = _binding(state)
    return binding is not None and binding.status == "uncertain" and (binding.detail or "").startswith(DEFERRED)


async def _defer_folder_r(world, state, *, failure=None, restrict_until=None):
    """Baseline, then a 410 controlled rescan that cannot read ``folder-r``."""
    assert (await world.run(state)).authoritative_complete is True
    reconciled = list(world.reconciled)
    if failure is not None:
        world.unreadable["folder-r"] = failure
    if restrict_until is not None:
        _restrict(world, "folder-r", restrict_until)
    world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
    await world.run(state)
    world.cursor_errors.clear()
    namespace = world.namespace("shared-a")
    for _ in range(3):
        progress = state.get_progress(namespace)
        if _deferred(state) and progress.building_snapshot is None and progress.listing_complete:
            break
        await world.run(state)
    assert _deferred(state)
    assert {"doc-n", "doc-m", "doc-o", "doc-h"} <= set(state.membership_ids(namespace, GEN))
    return reconciled


def _held(world, state, outcome, reconciled, doc="doc-n"):
    namespace = world.namespace("shared-a")
    assert doc not in world.removed  # no sink removal
    assert doc in state.membership_ids(namespace, GEN)  # membership and claim retained
    assert "folder-r" in state.membership_roots(namespace, GEN, doc)
    assert not state.has_owed_work(namespace, GEN, doc)  # neither a remove nor a speculative upsert
    assert outcome.failure_categories.get("deferred_root_document_held") == 1
    assert outcome.authoritative_complete is False and world.reconciled == reconciled
    assert _deferred(state)  # the root's recovery obligation stands


@pytest.mark.asyncio
async def test_a_nested_edit_under_a_timed_out_root_is_held_when_the_root_then_reads_present(
    tmp_path, monkeypatch,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "timeout.sqlite"))
    reconciled = await _defer_folder_r(world, state, failure=_timeout())

    # The probe times out once; any later read of folder-r would find it present.
    world.unreadable = _Once({"folder-r": _timeout()})
    _edit(world, "doc-n", "shared-a", "2026-10-01T00:00:00Z")
    _edit(world, "doc-h", "shared-a", "2026-10-01T00:00:00Z")
    world.calls.clear()
    world.pushed.clear()
    outcome = await world.run(state)

    _held(world, state, outcome, reconciled)
    assert world.calls.count(("metadata", "folder-r")) == 1  # the bounded probe, nothing more
    assert not any(call[0] == "list" for call in world.calls)  # no rescan for the held change
    assert "doc-h" in world.pushed and "doc-n" not in world.pushed  # the sibling's edit flows
    state.close()


@pytest.mark.asyncio
async def test_a_nested_edit_is_held_when_the_roots_minimum_lapses_between_admission_and_classification(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "expiry.sqlite"))
    reconciled = await _defer_folder_r(
        world, state, restrict_until=(clock.at + timedelta(minutes=2)).isoformat(),
    )

    # Restricted at the stream's admission check; lapsed by the time the page is classified.
    world.change_errors = _AdvanceClockOnChangeRead(clock, timedelta(minutes=5))
    _edit(world, "doc-n", "shared-a", "2026-10-01T00:00:00Z")
    world.calls.clear()
    outcome = await world.run(state)

    _held(world, state, outcome, reconciled)
    assert ("metadata", "folder-r") not in world.calls  # no probe, and no read to classify the edit

    # Restoration: the minimum has passed, so the root is probed, listed again and settled; the
    # nested document flows and the connection completes — nothing was ever removed.
    world.change_errors = {}
    world.pushed.clear()
    for _ in range(4):
        outcome = await world.run(state)
        if outcome.authoritative_complete:
            break
    assert outcome.authoritative_complete is True
    binding = _binding(state)
    assert binding.status == "bound" and not binding.detail
    assert "doc-n" in world.pushed and "doc-n" in world.reconciled[-1]
    assert "doc-n" not in world.removed
    state.close()


@pytest.mark.asyncio
async def test_held_scope_persists_across_reopen_keeps_overlap_and_never_widens_or_invents(
    tmp_path, monkeypatch,
):
    world = _world(monkeypatch)
    path = str(tmp_path / "persist.sqlite")
    state = StateStore(path)
    reconciled = await _defer_folder_r(world, state, failure=_timeout())
    state.close()

    # Reopened while deferred (the probe keeps timing out). A nested edit, an edit to a document
    # also selected directly, a NEW document under the unknown subfolder, and an unrelated one.
    state = StateStore(path)
    namespace = world.namespace("shared-a")
    world.put("doc-fresh", drive="shared-a", parent="sub")
    world.put("doc-new", drive="shared-a")
    for doc in ("doc-n", "doc-o", "doc-fresh", "doc-new"):
        _edit(world, doc, "shared-a", "2026-10-02T00:00:00Z")
    world.pushed.clear()
    outcome = await world.run(state)

    _held(world, state, outcome, reconciled)
    assert "doc-o" in world.pushed  # the independent direct claim proceeds
    assert {"doc-o", "folder-r"} <= set(state.membership_roots(namespace, GEN, "doc-o"))  # overlap kept
    members = set(state.membership_ids(namespace, GEN))
    assert "doc-fresh" not in members and "doc-new" not in members  # retained evidence never widens
    assert "doc-fresh" not in world.pushed and "doc-new" not in world.pushed
    state.close()

    # Fresh local state: nothing retained, so nothing is invented — and nothing is removed.
    fresh = StateStore(str(tmp_path / "fresh.sqlite"))
    for _ in range(2):
        await world.run(fresh)
    fresh_members = set(fresh.membership_ids(namespace, GEN))
    assert "doc-n" not in fresh_members and "doc-fresh" not in fresh_members
    assert "doc-n" not in world.removed
    fresh.close()


@pytest.mark.asyncio
async def test_after_verified_enumeration_the_nested_edit_flows_and_a_real_move_out_reconciles(
    tmp_path, monkeypatch,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "recovery.sqlite"))
    await _defer_folder_r(world, state, failure=_timeout())

    # While deferred: doc-n is edited, and doc-m really moves out of the selection.
    world.put("elsewhere", drive="shared-a", folder=True)
    world.files["doc-m"]["parents"] = ["elsewhere"]
    _edit(world, "doc-m", "shared-a", "2026-10-03T00:00:00Z")
    _edit(world, "doc-n", "shared-a", "2026-10-03T00:00:00Z")
    held = await world.run(state)
    assert held.authoritative_complete is False
    assert "doc-m" not in world.removed and "doc-n" not in world.removed  # held, not inferred absent

    # The root reads again: the probe authorizes the controlled rescan, which lists it and settles it.
    world.unreadable = {}
    world.pushed.clear()
    outcome = held
    for _ in range(4):
        outcome = await world.run(state)
        if outcome.authoritative_complete:
            break
    assert outcome.authoritative_complete is True
    binding = _binding(state)
    assert binding.status == "bound" and not binding.detail
    assert "doc-n" in world.pushed  # the nested update flows after verified enumeration
    final = set(world.reconciled[-1])
    assert {"doc-n", "doc-o", "doc-h"} <= final
    assert "doc-m" not in final  # the real move out is reconciled — by the verified complete snapshot
    assert "doc-m" not in world.removed and "doc-n" not in world.removed  # never by inference
    state.close()


@pytest.mark.asyncio
async def test_a_root_that_keeps_timing_out_is_probed_once_per_poll_and_siblings_are_never_relisted(
    tmp_path, monkeypatch,
):
    world = _world(monkeypatch)
    path = str(tmp_path / "polls.sqlite")
    state = StateStore(path)
    await _defer_folder_r(world, state, failure=_timeout())
    namespace = world.namespace("shared-a")

    for poll in range(3):
        state.close()
        state = StateStore(path)  # local state reopened between polls
        _edit(world, "doc-h", "shared-a", f"2026-10-0{4 + poll}T00:00:00Z")
        world.calls.clear()
        world.pushed.clear()
        outcome = await world.run(state)
        assert world.calls.count(("metadata", "folder-r")) == 1  # one bounded probe per run
        assert not any(call[0] == "list" for call in world.calls)  # no sibling relisting
        assert "doc-h" in world.pushed  # the healthy sibling's edit drains
        assert "doc-n" in state.membership_ids(namespace, GEN)  # retained nested docs stay
        assert outcome.authoritative_complete is False and _deferred(state)
        assert outcome.failure_categories.get("provider_timeout") == 1

    # Repaired: the next probe reads the root, the controlled rescan recovers it, and the
    # connection reconciles.
    world.unreadable = {}
    for _ in range(4):
        outcome = await world.run(state)
        if outcome.authoritative_complete:
            break
    assert outcome.authoritative_complete is True and not _deferred(state)
    state.close()


@pytest.mark.asyncio
async def test_a_probe_answered_with_a_named_minimum_records_it_and_no_further_probe_is_made(
    tmp_path, monkeypatch,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "named.sqlite"))
    await _defer_folder_r(world, state, failure=_timeout())

    world.unreadable = {"folder-r": real_deferral(503, LONG)}
    probed = await world.run(state)
    assert "folder-r" in state.document_restrictions(world.integration_id, GEN, "account")
    assert probed.failure_categories.get("provider_unavailable") == 1
    assert _deferred(state)

    # Standing minimum: zero probes, while the stream's independent changes still drain.
    world.unreadable = {}
    for _ in range(2):
        _edit(world, "doc-h", "shared-a", "2026-10-09T00:00:00Z")
        world.calls.clear()
        world.pushed.clear()
        await world.run(state)
        assert ("metadata", "folder-r") not in world.calls
        assert "doc-h" in world.pushed
    state.close()


@pytest.mark.asyncio
async def test_a_quota_answer_to_the_probe_is_the_accounts_hold(tmp_path, monkeypatch):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "quota.sqlite"))
    await _defer_folder_r(world, state, failure=_timeout())

    world.unreadable = {"folder-r": real_deferral(429, "3600")}
    _edit(world, "doc-h", "shared-a", "2026-10-10T00:00:00Z")
    world.calls.clear()
    outcome = await world.run(state)

    assert outcome.failure_categories.get("rate_limited") == 1
    assert state.connection_hold(world.integration_id, GEN, "account") is not None
    assert world.calls[-1] == ("metadata", "folder-r")  # no further account call after the answer
    assert _deferred(state)
    state.close()
