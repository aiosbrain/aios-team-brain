"""Observed provider minimums survive every short circuit, and an unpublished hold is repaired
(AIO-1167 R51 F2/F3).

Spec (Astra R50 adjudication, findings 2 and 3).

F2 — a root's provider-named minimum is written to the coordinator's local restriction journal the
moment it is read, BEFORE the next root's read can end the binding: a later quota answer (429 or a
quota 403), a nonterminal BrainError, a terminal authority refusal or the run's own budget never
drops it. Every orderly early return publishes it where authority allows; under a terminal refusal
it is kept locally and reported unpublished, with the original error. The root is not read again
before its minimum — on the same state, and (once published) on a fresh one.

F3 — a drain-phase account hold whose checkpoint fails is kept locally, reported
``account_hold_unpublished`` ONCE beside the checkpoint's own error, with no further provider call.
The next acquisition repairs the publication on the standing-hold early return — from its fresh
acknowledged document, preserving sibling streams — before returning and without a provider call;
a fresh state file then honours the acknowledged hold. Resource and hold evidence report their own
categories.
"""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import pytest

from aios_ingest.brain_client import BrainError
from aios_ingest.gdrive_sync import _bind_selected_roots, _reobserve_stalled_relocations
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import StateStore
from test_document_restrictions import _world as _folder_world
from test_document_restrictions import clock, run  # noqa: F401 (clock is a fixture)
from test_gdrive_upgrade import _DriveWorld
from test_root_evidence_r49 import real_deferral

GEN = 9
LONG = "99999999"


def _items(world):
    return {item["id"] for item in (world.progress.get("document_restrictions") or {}).get("items", [])}


def _two_root_world(monkeypatch):
    world = _DriveWorld(file_ids=["file-a", "file-b"]).install(monkeypatch)
    world.put("file-a", drive="shared-a")
    world.put("file-b", drive="shared-a")
    return world


LATER = {
    "429": lambda: real_deferral(429, "60"),
    "403-quota": lambda: real_deferral(403, "60", reason="userRateLimitExceeded"),
    "brain-error": lambda: BrainError(503, "server_error", "brain unavailable"),
    "authority": lambda: BrainError(409, "stale_execution", "superseded"),
    "local-deadline": lambda: ProviderDeferred("run budget spent", category="dispatch_deadline"),
}


@pytest.mark.parametrize("later", list(LATER))
@pytest.mark.asyncio
async def test_an_earlier_roots_named_minimum_survives_a_later_short_circuit(
    tmp_path, monkeypatch, clock, later,
):
    world = _two_root_world(monkeypatch)
    world.unreadable["file-a"] = real_deferral(503, LONG)  # read first: a long valid minimum
    world.unreadable["file-b"] = LATER[later]()           # read next: ends the binding
    state = StateStore(str(tmp_path / f"order-{later}.sqlite"))

    summary = await world.run(state)

    assert "file-a" in state.document_restrictions(world.integration_id, GEN, "account")
    assert summary.failure_categories.get("provider_unavailable") == 1  # A's deferral is reported
    if later == "authority":
        # Never published under lost authority: kept locally, said so, original error kept.
        assert summary.failure_categories.get("stale_execution") == 1
        assert summary.failure_categories.get("document_restriction_unpublished") == 1
        assert "file-a" not in _items(world)
    else:
        assert "file-a" in _items(world)  # flushed by the orderly early return
        assert "document_restriction_unpublished" not in summary.failure_categories
    if later in ("429", "403-quota"):
        assert world.progress["account_hold"]["category"] == "rate_limited"  # added, not replacing

    # Past B's hold, long before A's minimum: A is not read again.
    clock.at += timedelta(minutes=2)
    world.unreadable.pop("file-b")
    world.calls.clear()
    await world.run(state)
    assert ("metadata", "file-a") not in world.calls
    if later != "authority":
        fresh = StateStore(str(tmp_path / f"order-{later}-fresh.sqlite"))
        world.calls.clear()
        await world.run(fresh)
        assert ("metadata", "file-a") not in world.calls  # restored from the brain
        fresh.close()
    state.close()


@pytest.mark.asyncio
async def test_a_failed_publication_is_kept_reported_per_owner_and_repaired_on_reacquisition(
    tmp_path, monkeypatch, clock,
):
    world = _two_root_world(monkeypatch)
    world.unreadable["file-a"] = real_deferral(503, LONG)
    world.unreadable["file-b"] = real_deferral(429, "3600")
    world.checkpoint_faults.append(lambda _payload: BrainError(503, "server_error", "brain unavailable"))
    state = StateStore(str(tmp_path / "repair.sqlite"))

    held = await world.run(state)

    assert held.failure_categories.get("account_hold_unpublished") == 1
    assert held.failure_categories.get("document_restriction_unpublished") == 1
    assert state.connection_hold(world.integration_id, GEN, "account") is not None
    assert "file-a" in state.document_restrictions(world.integration_id, GEN, "account")
    assert "account_hold" not in world.progress and not _items(world)  # never claimed durable

    # Reacquisition while the hold stands: repaired before returning, with no provider call.
    world.calls.clear()
    repaired = await world.run(state)
    assert world.calls == []
    assert "account_hold_unpublished" not in repaired.failure_categories
    assert "document_restriction_unpublished" not in repaired.failure_categories
    assert world.progress["account_hold"]["category"] == "rate_limited" and "file-a" in _items(world)

    # A fresh state file honours what the brain now holds.
    fresh = StateStore(str(tmp_path / "repair-fresh.sqlite"))
    await world.run(fresh)
    assert world.calls == []
    fresh.close()
    state.close()


@pytest.mark.asyncio
async def test_a_drain_phase_hold_whose_checkpoint_fails_is_reported_once_and_repaired_before_any_call(
    tmp_path, monkeypatch, clock,
):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / "drain.sqlite"))
    assert (await world.run(state)).authoritative_complete is True

    def lost_hold(payload):
        return BrainError(503, "server_error", "brain unavailable") if payload.get("account_hold") else None

    world.files["doc-a"]["modifiedTime"] = "2026-10-01T00:00:00Z"
    world.logs["shared-a"].append({"fileId": "doc-a", "file": dict(world.files["doc-a"])})
    world.unreadable["doc-a"] = real_deferral(429, "3600")
    world.checkpoint_faults.extend([lost_hold] * 10)  # every publication attempt this run fails
    world.calls.clear()
    summary = await run(world, state)

    assert summary.failure_categories.get("rate_limited") == 1
    assert summary.failure_categories.get("account_hold_unpublished") == 1  # once per run
    assert summary.failure_categories.get("server_error") == 1  # the checkpoint's own error kept
    assert "document_restriction_unpublished" not in summary.failure_categories
    assert summary.failed == 0 and summary.authoritative_complete is False
    assert state.connection_hold(world.integration_id, GEN, "account") is not None
    assert "account_hold" not in world.progress
    assert world.calls[-1] == ("metadata", "doc-a")  # no provider call after the quota answer

    # Reacquired with publication restored, the hold still standing: repaired, no provider call.
    world.checkpoint_faults.clear()
    world.unreadable.pop("doc-a")
    world.calls.clear()
    repaired = await run(world, state)
    assert world.calls == []
    assert "account_hold_unpublished" not in repaired.failure_categories
    assert world.progress["account_hold"]["category"] == "rate_limited"
    assert set(world.progress["streams"]) == {"shared-a"}  # sibling progress preserved

    fresh = StateStore(str(tmp_path / "drain-fresh.sqlite"))
    await run(world, fresh)
    assert world.calls == []
    fresh.close()
    state.close()


def _recording_source(order, answers):
    class Source:
        def _metadata(self, root_id):
            order.append(("read", root_id))
            raise answers[root_id]()
    return Source()


def test_binding_hands_each_minimum_to_the_journal_before_the_next_root_is_read():
    order: list[tuple[str, str]] = []
    state = SimpleNamespace(
        root_bindings=lambda *_a: {}, mark_root_unresolved=lambda *_a, **_k: None,
    )
    source = _recording_source(order, {
        "r1": lambda: real_deferral(503, LONG), "r2": lambda: real_deferral(429, "60"),
    })
    with pytest.raises(ProviderDeferred):
        _bind_selected_roots(
            source, state, "integration", GEN, {"file_ids": ["r1", "r2"]},
            observe=lambda root_id, _exc: order.append(("observe", root_id)),
        )
    assert order == [("read", "r1"), ("observe", "r1"), ("read", "r2")]


def test_the_relocation_reread_hands_each_minimum_to_the_journal_before_the_next_read():
    order: list[tuple[str, str]] = []
    relocating = SimpleNamespace(status="relocating", pending_drive_id="dest", drive_id="shared-a")
    state = SimpleNamespace(
        unsettled_roots=lambda *_a: {("file", "r1"): relocating, ("file", "r2"): relocating},
    )
    source = _recording_source(order, {
        "r1": lambda: real_deferral(503, LONG), "r2": lambda: real_deferral(429, "60"),
    })
    with pytest.raises(ProviderDeferred):
        _reobserve_stalled_relocations(
            source, state, "integration", GEN, lambda _drive: True,
            observe=lambda root_id, _exc: order.append(("observe", root_id)),
        )
    assert order == [("read", "r1"), ("observe", "r1"), ("read", "r2")]
