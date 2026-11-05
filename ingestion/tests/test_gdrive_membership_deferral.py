"""AIO-1167 R64 — a deferred membership answer reaches its owner, wherever routing first asks.

Spec (Astra R64 adjudication, P2). An already-bound explicit FILE root can make the run's FIRST call to
the membership oracle (`drives.get`) from ordinary change classification or from explicit-file
recovery enumeration. Through the real coordinator and StateStore over ``_DriveWorld`` (a fresh source
per run, so the membership cache is cold):

  * a QUOTA answer is the account's hold — recorded locally and published, no further provider call
    this run or before Retry-After (across reopen, a generation change and fresh local state), claims
    and the replayable cursor kept, and never an escaped coordinator error;
  * a PROVIDER-NAMED non-quota minimum is that ROOT's: a durable restriction (published, and refused
    or lost publication reported truthfully then repaired), root debt, no account hold, no removal,
    no false completeness; the same stream's healthy sibling and a separate stream still progress; a
    standing restriction is admitted BEFORE classification can probe; the minimum survives reopen,
    a generation change and fresh state, and converges after it passes;
  * a TIMEOUT without a named minimum, or the run's own deadline, keeps claims, debt and its category
    and the page replayable, records no account hold and no provider minimum, and probes once;
  * explicit-file recovery enumeration (affected root before a healthy sibling) does the same, with
    the healthy sibling enumerated;
  * a root-authority CONFLICT from two persisted worker states is cleared on the user log only with
    routing proof: unknown membership stays partial across reopen, while definitive non-membership,
    proven membership and a physical move to My Drive converge.
"""

from __future__ import annotations

import shutil
from datetime import timedelta

import pytest

from aios_ingest.brain_client import BrainError, GdriveExecution
from aios_ingest.connector_state import parse_restriction_evidence
from aios_ingest.gdrive_sync import _adopt_remote_root_evidence
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import ROOT_AUTHORITY_CONFLICT_DETAIL, ROOT_DEFERRED_PREFIX, StateStore
from test_document_restrictions import clock  # noqa: F401 (a fixture)
from test_gdrive_membership_drive_event import DRIVE_EVENT, _binding, _converge
from test_gdrive_membership_drive_event import _world as _routing_world
from test_gdrive_upgrade import _WORLD_INTEGRATION

GEN, ACCOUNT = 9, "account"
CATEGORY = {"quota": "rate_limited", "named": "provider_unavailable", "timeout": "provider_timeout",
            "deadline": "run_deadline"}


def _world(monkeypatch):
    """file-f: shared-d, a non-member's, consumed by the user log; file-m: My Drive (same stream);
    file-x: a member's file in shared-x (a separate stream)."""
    world = _routing_world(monkeypatch)
    world.config["fileIds"].append("file-x")
    world.put("file-x", drive="shared-x")
    world.membership["shared-x"] = "member"
    return world


def _deferral(kind, clock):
    soon = (clock.at + timedelta(hours=1)).isoformat()
    if kind == "quota":
        return ProviderDeferred("quota", not_before=soon, category="rate_limited", provider_deadline=True)
    if kind == "named":
        return ProviderDeferred("unavailable", not_before=soon, category="provider_unavailable",
                                provider_deadline=True)
    return ProviderDeferred(kind, category=CATEGORY[kind])  # no provider-named minimum


def _edit(world, doc, log, stamp="2026-10-01T00:00:00Z"):
    world.files[doc]["modifiedTime"] = stamp
    world.logs.setdefault(log, []).append({"fileId": doc, "file": dict(world.files[doc])})


def _evidence(world):
    return parse_restriction_evidence(world.progress).get(ACCOUNT) or {"hold": None, "resources": {}}


def _restrictions(state):
    return state.document_restrictions(_WORLD_INTEGRATION, GEN, ACCOUNT)


def _hold(state):
    return state.connection_hold(_WORLD_INTEGRATION, GEN, ACCOUNT)


def _probes(world):
    return [index for index, call in enumerate(world.calls) if call == ("drives.get", "shared-d")]


async def _baseline(tmp_path, monkeypatch, name):
    world = _world(monkeypatch)
    path = str(tmp_path / name)
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    assert _binding(state) == ("bound", "my-drive", None, None)
    assert _binding(state, "file-x") == ("bound", "shared-x", None, None)
    return world, path, state


async def _settle(world, state, path, *, runs=6):
    for _ in range(runs):
        summary = await world.run(state)
        if summary.authoritative_complete:
            return summary
    return summary


# ── ordinary change classification ─────────────────────────────────────────────────────────────

async def _classify_under_deferral(tmp_path, monkeypatch, clock, kind, name):
    world, path, state = await _baseline(tmp_path, monkeypatch, name)
    pushed = {doc: world.pushed.count(doc) for doc in ("file-f", "file-m", "file-x")}
    _edit(world, "file-f", "my-drive")  # the non-member's file is reported in the user log…
    _edit(world, "file-m", "my-drive")  # …before a healthy sibling of the same stream
    _edit(world, "file-x", "shared-x")  # and a separate stream has its own edit
    world.membership["shared-d"] = _deferral(kind, clock)
    world.calls.clear()
    summary = await world.run(state)  # returns: nothing escapes as a coordinator error
    probes = _probes(world)
    assert probes, "classification asked the membership oracle"
    assert any(call[:2] == ("changes", "my-drive") for call in world.calls[:probes[0]]), (
        "the first membership call of this fresh source is the classification's own"
    )
    assert world.removed == [] and summary.authoritative_complete is False
    return world, path, state, summary, pushed, probes


@pytest.mark.parametrize("kind", ["quota", "named", "timeout", "deadline"])
@pytest.mark.asyncio
async def test_ordinary_classification_routes_a_membership_deferral_to_its_owner(
    tmp_path, monkeypatch, clock, kind,
):
    world, path, state, summary, pushed, probes = await _classify_under_deferral(
        tmp_path, monkeypatch, clock, kind, f"classify-{kind}.sqlite",
    )
    assert summary.failure_categories.get(CATEGORY[kind], 0) >= 1, "the category is kept"
    assert "coordinator_error" not in summary.failure_categories
    if kind == "quota":
        assert _hold(state) is not None and _hold(state)[1] == "rate_limited"
        assert _evidence(world)["hold"] is not None, "the account hold is published"
        assert world.calls[probes[0] + 1:] == [], "no further provider call this run"
        assert "file-f" not in _restrictions(state)
    elif kind == "named":
        assert _hold(state) is None, "a root's minimum is not the account's"
        assert "file-f" in _restrictions(state) and "file-f" in _evidence(world)["resources"]
        assert world.pushed.count("file-m") > pushed["file-m"], "the same stream's healthy sibling progressed"
        assert world.pushed.count("file-x") > pushed["file-x"], "a separate stream progressed"
        assert len(probes) == 1
    else:
        assert _hold(state) is None and "file-f" not in _restrictions(state), "no provider minimum"
        assert "file-f" not in _evidence(world)["resources"]
        assert len(probes) == 1, "probed once, no same-run loop"
        assert world.pushed.count("file-f") == pushed["file-f"], "the page was not retained"

    # Reopen before any minimum passes.
    state.close()
    state = StateStore(path)
    world.calls.clear()
    held = await world.run(state)
    assert held.authoritative_complete is False and world.removed == []
    if kind == "quota":
        assert world.calls == [], "no provider call before Retry-After"
    elif kind == "named":
        assert ("drives.get", "shared-d") not in world.calls, "a standing minimum is admitted before any probe"
        assert ("metadata", "file-f") not in world.calls and ("doc", "file-f") not in world.calls
        status, drive, _pending, detail = _binding(state)
        assert (status, drive) == ("uncertain", "my-drive") and detail.startswith(ROOT_DEFERRED_PREFIX), "root debt"
        # A NEW change for the restricted root: its classification is admitted before any probe.
        _edit(world, "file-f", "my-drive", stamp="2026-10-02T00:00:00Z")
        world.calls.clear()
        assert (await world.run(state)).authoritative_complete is False
        assert ("drives.get", "shared-d") not in world.calls, "no membership probe under a standing minimum"
        assert any(call[:2] == ("changes", "my-drive") for call in world.calls), "the change page was read"

    # The minimum passes and the drive answers definitively: the held edit converges.
    clock.at += timedelta(hours=2)
    world.membership["shared-d"] = "nonmember"
    summary = await _settle(world, state, path)
    assert summary.authoritative_complete is True
    assert world.pushed.count("file-f") > pushed["file-f"], "the held edit is ingested — the page replayed"
    assert _binding(state) == ("bound", "my-drive", None, None)
    assert world.removed == []
    state.close()


@pytest.mark.parametrize("restart", ["new-generation", "fresh-state"])
@pytest.mark.parametrize("kind", ["quota", "named"])
@pytest.mark.asyncio
async def test_a_membership_minimum_survives_a_generation_change_and_fresh_state(
    tmp_path, monkeypatch, clock, kind, restart,
):
    world, path, state, *_ = await _classify_under_deferral(
        tmp_path, monkeypatch, clock, kind, f"survive-{kind}-{restart}.sqlite",
    )
    if restart == "new-generation":
        world.generation += 1
    else:
        state.close()
        state = StateStore(str(tmp_path / f"fresh-{kind}.sqlite"))  # exclusively the brain's evidence
    world.calls.clear()
    await world.run(state)
    if kind == "quota":
        assert world.calls == [], "the account hold stands"
    else:
        assert ("drives.get", "shared-d") not in world.calls
        assert ("metadata", "file-f") not in world.calls, "the root's minimum stands"
        assert "file-f" in state.document_restrictions(_WORLD_INTEGRATION, world.generation, ACCOUNT)
    assert world.removed == []

    clock.at += timedelta(hours=2)
    world.membership["shared-d"] = "nonmember"
    summary = await _settle(world, state, path)
    assert summary.authoritative_complete is True and world.removed == []
    state.close()


@pytest.mark.parametrize("failure", ["refused", "lost"])
@pytest.mark.asyncio
async def test_an_unacknowledged_root_minimum_is_kept_reported_and_repaired(tmp_path, monkeypatch, clock, failure):
    world, path, state = await _baseline(tmp_path, monkeypatch, f"publication-{failure}.sqlite")
    _edit(world, "file-f", "my-drive")
    world.membership["shared-d"] = _deferral("named", clock)

    def carries(progress):
        return "file-f" in (parse_restriction_evidence(progress).get(ACCOUNT) or {}).get("resources", {})

    if failure == "refused":
        world.checkpoint_faults.extend(
            [lambda progress: BrainError(503, "checkpoint_unavailable", "refused") if carries(progress) else None] * 8
        )
    else:
        world.lost_checkpoints.extend([carries] * 8)
    summary = await world.run(state)

    assert "file-f" in _restrictions(state), "the local minimum is kept"
    assert _hold(state) is None and world.removed == [] and summary.authoritative_complete is False
    if failure == "refused":
        assert "file-f" not in _evidence(world)["resources"]
        assert summary.failure_categories.get("document_restriction_unpublished") == 1, "reported truthfully"
    else:
        # Committed, unacknowledged: the run stops on the unknown revision rather than guessing.
        assert summary.failure_categories.get("checkpoint_acknowledgment_lost", 0) >= 1

    world.checkpoint_faults.clear()
    world.lost_checkpoints.clear()
    state.close()
    state = StateStore(path)
    world.calls.clear()
    repaired = await world.run(state)
    assert "file-f" in _evidence(world)["resources"], "a fresh acquisition repairs the publication"
    assert "document_restriction_unpublished" not in repaired.failure_categories
    assert ("drives.get", "shared-d") not in world.calls
    state.close()


# ── explicit-file recovery enumeration ─────────────────────────────────────────────────────────

@pytest.mark.parametrize("kind", ["quota", "named", "timeout", "deadline"])
@pytest.mark.asyncio
async def test_recovery_enumeration_defers_only_the_affected_root(tmp_path, monkeypatch, clock, kind):
    world, path, state = await _baseline(tmp_path, monkeypatch, f"recovery-{kind}.sqlite")
    world.progress["streams"]["my-drive"]["checkpoint_id"] = "page-this-sidecar-never-retired"
    world.revision += 1  # the user log owes a controlled recovery
    world.membership["shared-d"] = _deferral(kind, clock)
    world.calls.clear()
    summary = await world.run(state)

    probes = _probes(world)
    assert probes and world.calls.index(("metadata", "file-f")) < probes[0], "file-f is enumerated first"
    assert "coordinator_error" not in summary.failure_categories
    assert summary.failure_categories.get(CATEGORY[kind], 0) >= 1
    assert world.removed == [] and summary.authoritative_complete is False
    after = world.calls[probes[0] + 1:]
    if kind == "quota":
        assert _hold(state) is not None and after == []
    elif kind == "deadline":
        assert _hold(state) is None and "file-f" not in _restrictions(state), "a local stop, no minimum"
    else:
        assert ("metadata", "file-m") in after, "the healthy sibling is still enumerated"
        assert state.get_progress(world.namespace("my-drive")).retry_not_before is None, "the stream is not paused"
        status, _drive, _pending, detail = _binding(state)
        assert status == "uncertain" and detail.startswith(ROOT_DEFERRED_PREFIX), "root-local debt"
        assert _hold(state) is None
        assert ("file-f" in _restrictions(state)) is (kind == "named"), "only a provider-named minimum persists"
        assert len(probes) == 1

    clock.at += timedelta(hours=2)
    world.membership["shared-d"] = "nonmember"
    summary = await _settle(world, state, path)
    assert summary.authoritative_complete is True and _binding(state) == ("bound", "my-drive", None, None)
    state.close()


# ── root-authority conflict from two persisted worker states ───────────────────────────────────

@pytest.mark.parametrize("answer", ["unknown", "definitive-nonmember", "proven-member", "moved-to-my-drive"])
@pytest.mark.asyncio
async def test_a_conflicted_user_log_root_is_cleared_only_with_routing_proof(tmp_path, monkeypatch, answer):
    world, path, w1 = await _baseline(tmp_path, monkeypatch, f"conflict-w1-{answer}.sqlite")
    w1.close()
    w2_path = str(tmp_path / f"conflict-w2-{answer}.sqlite")
    shutil.copy(path, w2_path)  # two workers, the same persisted acknowledged baseline
    world.logs["my-drive"].append(dict(DRIVE_EVENT))

    # W2 transitions locally (the event's membership debt) but none of its checkpoints is accepted.
    world.membership["shared-d"] = "unknown"
    def carries_debt(progress):
        return any(
            item.get("id") == "file-f" and item.get("status") == "uncertain"
            for item in (progress.get("roots") or {}).get("items") or []
        )

    world.checkpoint_faults.extend([
        lambda progress: BrainError(503, "checkpoint_unavailable", "refused") if carries_debt(progress) else None,
    ] * 12)
    w2 = StateStore(w2_path)
    await world.run(w2)
    assert _binding(w2)[0] == "uncertain"
    world.checkpoint_faults.clear()
    w2.close()

    # W1 publishes a DIFFERENT canonical history from the same baseline: the debt, then settled.
    world.membership["shared-d"] = "nonmember"
    w1 = StateStore(path)
    for _ in range(3):
        await world.run(w1)
    assert _binding(w1) == ("bound", "my-drive", None, None)
    w1.close()

    # W2 reacquires: its unpublished transition conflicts with the newer authority.
    world.membership["shared-d"] = "unknown"
    w2 = StateStore(w2_path)
    _adopt_remote_root_evidence(w2, GdriveExecution(
        _WORLD_INTEGRATION, GEN, 1, "probe", "later", "scope", {}, progress=world.progress,
    ), _WORLD_INTEGRATION, GEN)
    assert _binding(w2) == ("uncertain", "my-drive", None, ROOT_AUTHORITY_CONFLICT_DETAIL)

    if answer == "unknown":
        for reopen in (False, True, False):
            if reopen:
                w2.close()
                w2 = StateStore(w2_path)
            summary = await world.run(w2)
            assert summary.authoritative_complete is False, "unknown membership is no routing proof"
            assert _binding(w2) == ("uncertain", "my-drive", None, ROOT_AUTHORITY_CONFLICT_DETAIL)
            assert world.removed == []
    elif answer == "proven-member":
        world.membership["shared-d"] = "member"
        summary, w2 = await _converge(world, w2, w2_path)
        assert summary.authoritative_complete is True and _binding(w2) == ("bound", "shared-d", None, None)
    else:
        if answer == "definitive-nonmember":
            world.membership["shared-d"] = "nonmember"
        else:
            world.files["file-f"].pop("driveId")
            world.files["file-f"]["parents"] = ["my-drive"]
        summary = await _settle(world, w2, w2_path)
        assert summary.authoritative_complete is True and _binding(w2) == ("bound", "my-drive", None, None)
    assert world.removed == []
    w2.close()


# ── explicit trash of a direct user-log root never waits on routing (R65) ──────────────────────

@pytest.mark.asyncio
async def test_explicit_trash_of_a_direct_user_log_root_is_removed_without_a_membership_probe(
    tmp_path, monkeypatch, clock,
):
    world, _path, state = await _baseline(tmp_path, monkeypatch, "trash-no-probe.sqlite")
    # The very next user-log row is the trash itself, full file body (no live edit before it).
    world.files["file-f"]["trashed"] = True
    world.logs["my-drive"].append({"fileId": "file-f", "file": dict(world.files["file-f"])})
    world.membership["shared-d"] = _deferral("named", clock)
    world.calls.clear()
    await world.run(state)

    assert "file-f" in world.removed, "the claim-aware explicit-trash removal is emitted"
    assert ("drives.get", "shared-d") not in world.calls, "trash needs no routing decision"
    assert "file-f" not in _restrictions(state), "no membership-derived root restriction"
    assert "file-f" not in _evidence(world)["resources"]
    assert _hold(state) is None and _evidence(world)["hold"] is None, "no account hold"
    state.close()
