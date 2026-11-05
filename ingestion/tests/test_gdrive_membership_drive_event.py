"""AIO-1167 R61 fix 2 — a drive-only membership gain revalidates explicit-file routing.

Spec (Astra R61 adjudication, finding 2). Explicit file ``file-f`` lives in Shared Drive ``shared-d``
and, while the account is not a member, is consumed through the user log (``my-drive``). Membership
is then granted and the user log reports ONLY ``{changeType: drive, driveId: shared-d}`` — no file
row. Through the real coordinator over ``_DriveWorld`` with a ``drives.get`` membership oracle:

  * the event durably invalidates the user-log file roots (a published ``uncertain`` debt; the run is
    partial), and revalidation reuses the routing probes: ``file-f`` relocates to ``shared-d`` —
    whose start token is captured before anything is enumerated there — and is handed over through
    the verified-snapshot path, while a root really in My Drive settles where it is;
  * afterwards an edit reported ONLY in ``shared-d``'s log is ingested and a removal reported only
    there is reconciled;
  * the same holds across a restart after the event, during the destination's start-token
    acquisition, and around a refused or committed-but-lost hand-over checkpoint — with no
    premature completeness and the claims standing until the hand-over is verified;
  * controls: an unrelated drive's event selects nothing new and converges back; an unknown
    membership, an unreadable root and a provider Retry-After stay partial; a duplicated event is
    idempotent.
"""

from __future__ import annotations

import pytest

from aios_ingest import gdrive_sync
from aios_ingest.brain_client import BrainError
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import ROOT_MEMBERSHIP_EVENT_DETAIL, StateStore
from test_gdrive_upgrade import _WORLD_INTEGRATION, _DriveWorld, _Lazy, _ProviderHttpError

GEN = 9
FAR = "2999-01-01T00:00:00+00:00"
DRIVE_EVENT = {"changeType": "drive", "driveId": "shared-d"}


def _install_membership(world, monkeypatch):
    """``drives.get`` per drive: ``member`` answers, ``nonmember`` is a 404, ``unknown`` a 403, or raise."""
    world.membership = {"shared-d": "nonmember"}
    base = gdrive_sync.GoogleDriveSource

    class Drives:
        def get(self, driveId, **_kwargs):
            def answer():
                world.calls.append(("drives.get", driveId))
                verdict = world.membership.get(driveId, "unknown")
                if isinstance(verdict, Exception):
                    raise verdict
                if verdict == "member":
                    return {"id": driveId}
                raise _ProviderHttpError(404 if verdict == "nonmember" else 403)
            return _Lazy(answer)

    class Source(base):
        def _services(self):
            drive, docs = super()._services()

            class Routed:
                def changes(self):
                    return drive.changes()

                def files(self):
                    return drive.files()

                def drives(self):
                    return Drives()
            return Routed(), docs

    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)


def _install_lost_checkpoints(world, monkeypatch):
    """Checkpoints the brain COMMITS whose acknowledgment is lost, by predicate, once each."""
    world.lost_checkpoints, world.uncertain = [], False
    client = gdrive_sync.BrainClient
    checkpoint, acquire = client.checkpoint_gdrive_execution, client.acquire_gdrive_execution

    async def lossy(self, execution, progress):
        result = await checkpoint(self, execution, progress)
        for predicate in list(world.lost_checkpoints):
            if predicate(progress):
                world.lost_checkpoints.remove(predicate)
                world.uncertain = True
                raise BrainError(504, "checkpoint_acknowledgment_lost", "no acknowledgment arrived")
        return result

    async def fresh(self, requested, owner):
        world.uncertain = False
        return await acquire(self, requested, owner)

    monkeypatch.setattr(client, "checkpoint_gdrive_execution", lossy)
    monkeypatch.setattr(client, "acquire_gdrive_execution", fresh)
    monkeypatch.setattr(client, "gdrive_progress_uncertain", lambda self, execution: world.uncertain, raising=False)


def _world(monkeypatch):
    world = _DriveWorld(file_ids=["file-f", "file-m"]).install(monkeypatch)
    world.put("file-f", drive="shared-d")
    world.put("file-m", drive="my-drive")
    world.put("other-d", drive="shared-d")  # in the drive, never selected
    _install_membership(world, monkeypatch)
    _install_lost_checkpoints(world, monkeypatch)
    return world


def _binding(state, root="file-f"):
    binding = state.root_obligations(_WORLD_INTEGRATION, GEN)[("file", root)]
    return binding.status, binding.drive_id, binding.pending_drive_id, binding.detail


def _remote_root(world, root="file-f"):
    items = (world.progress.get("roots") or {}).get("items") or []
    return next((item for item in items if item["id"] == root), None)


def _root_published(root, status, drive_id):
    def matches(progress):
        return any(
            item.get("id") == root and item.get("status") == status and item.get("drive_id") == drive_id
            for item in (progress.get("roots") or {}).get("items") or []
        )
    return matches


async def _nonmember_baseline(tmp_path, monkeypatch, name):
    world = _world(monkeypatch)
    path = str(tmp_path / name)
    state = StateStore(path)
    baseline = await world.run(state)
    assert baseline.authoritative_complete is True
    assert _binding(state) == ("bound", "my-drive", None, None), "a non-member's file is the user log's"
    assert _binding(state, "file-m") == ("bound", "my-drive", None, None)
    assert sorted(world.pushed) == ["file-f", "file-m"]
    assert ("start", "shared-d") not in world.calls
    return world, path, state


async def _gain_membership_by_drive_event_only(world, state, *events):
    world.membership["shared-d"] = "member"
    for event in events or (DRIVE_EVENT,):
        world.logs.setdefault("my-drive", []).append(dict(event))
    world.calls.clear()
    return await world.run(state)


async def _converge(world, state, path, *, runs=6, reopen=False, faults=None):
    """Run to convergence. A hand-over checkpoint the brain refuses or never acknowledges fails its
    run (``faults`` records each); the worker restarts from its store and goes on."""
    summary = None
    for _ in range(runs):
        if reopen:
            state.close()
            state = StateStore(path)
        try:
            summary = await world.run(state)
        except BrainError as exc:
            assert faults is not None, f"unexpected brain failure: {exc}"
            faults.append(exc.code)
            assert _binding(state)[:2] != ("bound", "my-drive") or _binding(state)[3] is not None
            assert world.removed == [], "a failed hand-over checkpoint removes nothing"
            state.close()
            state = StateStore(path)
            continue
        if summary.authoritative_complete and _binding(state)[:2] == ("bound", "shared-d"):
            break
    return summary, state


async def _assert_drive_only_edits_and_removals_reach_the_brain(world, state):
    # An edit reported ONLY in shared-d's log is ingested…
    pushed = world.pushed.count("file-f")
    world.files["file-f"]["modifiedTime"] = "2026-10-01T00:00:00Z"
    world.logs["shared-d"].append({"fileId": "file-f", "file": dict(world.files["file-f"])})
    await world.run(state)
    assert world.pushed.count("file-f") == pushed + 1, "a shared-d-only edit is ingested"
    # …and a removal reported only there is reconciled (after the peer's drain barrier).
    del world.files["file-f"]
    world.logs["shared-d"].append({"fileId": "file-f", "removed": True})
    for _ in range(3):
        await world.run(state)
    assert "file-f" in world.removed, "a shared-d-only removal is reconciled"
    assert "other-d" not in world.pushed, "nothing else in the drive became selected"


@pytest.mark.parametrize(
    "boundary", ["none", "restart-after-event", "token-acquisition", "refused-handover", "lost-handover"],
)
@pytest.mark.asyncio
async def test_a_drive_only_membership_gain_revalidates_and_hands_the_file_root_over(
    tmp_path, monkeypatch, boundary,
):
    world, path, state = await _nonmember_baseline(tmp_path, monkeypatch, f"gain-{boundary}.sqlite")

    event_run = await _gain_membership_by_drive_event_only(world, state)

    # The event names no file, yet the user-log file roots are durably invalidated and published.
    assert event_run.authoritative_complete is False, "no completeness while routing is unverified"
    assert _binding(state) == ("uncertain", "my-drive", None, ROOT_MEMBERSHIP_EVENT_DETAIL)
    assert _remote_root(world)["status"] == "uncertain"
    assert world.removed == [] and ("start", "shared-d") not in world.calls
    if boundary == "restart-after-event":
        state.close()
        state = StateStore(path)
        assert _binding(state)[0] == "uncertain", "the debt survives a restart"
    if boundary == "token-acquisition":
        world.token_errors["shared-d"] = _ProviderHttpError(403)
    faults: list[str] = []
    if boundary == "refused-handover":
        world.checkpoint_faults.append(
            lambda progress: BrainError(503, "checkpoint_unavailable", "refused")
            if _root_published("file-f", "bound", "shared-d")(progress) else None
        )
    if boundary == "lost-handover":
        world.lost_checkpoints.append(_root_published("file-f", "bound", "shared-d"))

    if boundary == "token-acquisition":
        world.calls.clear()
        reconciled = list(world.reconciled)
        blocked = await world.run(state)
        # Revalidated toward shared-d, whose token cannot be had: nothing is enumerated there, the
        # root stays relocating on the user log, its claim stands, and the run is partial.
        assert ("drives.get", "shared-d") in world.calls and ("start", "shared-d") in world.calls
        assert blocked.authoritative_complete is False
        assert _binding(state)[:3] == ("relocating", "my-drive", "shared-d")
        assert not [call for call in world.calls if call[0] in ("changes", "list") and call[1] == "shared-d"]
        # The brain's claim stands: nothing removed, no complete snapshot reconciled meanwhile.
        assert world.removed == [] and world.reconciled == reconciled
        assert _remote_root(world)["status"] == "relocating"
        state.close()
        state = StateStore(path)
        world.token_errors.pop("shared-d")

    world.calls.clear()
    summary, state = await _converge(
        world, state, path, reopen=boundary != "none",
        faults=faults if boundary in ("refused-handover", "lost-handover") else None,
    )

    # Revalidation reused the routing probes; the root really in My Drive settled where it is.
    assert ("drives.get", "shared-d") in world.calls or boundary == "token-acquisition"
    assert _binding(state, "file-m") == ("bound", "my-drive", None, None)
    if boundary == "refused-handover":
        assert faults == ["checkpoint_unavailable"] and world.checkpoint_faults == []
    if boundary == "lost-handover":
        assert faults == ["checkpoint_acknowledgment_lost"] and world.lost_checkpoints == []
    assert summary.authoritative_complete is True
    assert _binding(state) == ("bound", "shared-d", None, None)
    assert set(state.root_obligations(_WORLD_INTEGRATION, GEN)[("file", "file-f")].handoff_sources) >= {"my-drive"}
    assert _remote_root(world)["status"] == "bound" and _remote_root(world)["drive_id"] == "shared-d"
    in_destination = [
        call for call in world.calls if call[0] in ("start", "changes", "list") and call[1] == "shared-d"
    ]
    assert in_destination[0] == ("start", "shared-d"), "nothing is read in shared-d before its token"
    destination = state.get_progress(world.namespace("shared-d"))
    assert destination is not None and destination.baseline_start_token == "shared-d@0", (
        "shared-d's token was captured before anything was enumerated there"
    )
    assert state.membership_ids(world.namespace("shared-d"), GEN) == ["file-f"]
    assert world.removed == [], "the hand-over removed nothing"
    await _assert_drive_only_edits_and_removals_reach_the_brain(world, state)
    state.close()


@pytest.mark.asyncio
async def test_control_an_unrelated_drive_event_selects_nothing_and_converges_back(tmp_path, monkeypatch):
    world, path, state = await _nonmember_baseline(tmp_path, monkeypatch, "unrelated.sqlite")
    world.logs["my-drive"].append({"changeType": "drive", "driveId": "shared-e"})
    world.calls.clear()
    assert (await world.run(state)).authoritative_complete is False
    summary = await world.run(state)  # revalidated: shared-d still answers non-membership

    assert summary.authoritative_complete is True
    assert _binding(state) == ("bound", "my-drive", None, None)
    assert not [call for call in world.calls if call[0] in ("start", "changes", "list") and call[1] != "my-drive"]
    assert "other-d" not in world.pushed and world.removed == []
    state.close()


@pytest.mark.parametrize(
    "answer", ["unknown-membership", "unknown-membership-and-a-file-row", "root-read-failure", "retry-after"],
)
@pytest.mark.asyncio
async def test_control_an_unproven_revalidation_stays_partial(tmp_path, monkeypatch, answer):
    world, path, state = await _nonmember_baseline(tmp_path, monkeypatch, f"partial-{answer}.sqlite")
    await _gain_membership_by_drive_event_only(world, state)
    if answer.startswith("unknown-membership"):
        world.membership["shared-d"] = "unknown"  # a 403: never proof either way
    if answer == "unknown-membership-and-a-file-row":
        # The user log then reports the file itself, ambiguously: its root is read where it is
        # bound and readable — which an unknown membership cannot turn into proof of the route.
        world.logs["my-drive"].append({"fileId": "file-f", "removed": True})
    elif answer == "root-read-failure":
        world.unreadable["file-f"] = _ProviderHttpError(500)
    else:
        world.unreadable["file-f"] = ProviderDeferred(
            "Retry-After", not_before=FAR, category="provider_unavailable", provider_deadline=True,
        )
    for reopen in (False, True, False):
        if reopen:
            state.close()
            state = StateStore(path)
        summary = await world.run(state)
        assert summary.authoritative_complete is False, "partial until the routing is proven"
        assert _binding(state) == ("uncertain", "my-drive", None, ROOT_MEMBERSHIP_EVENT_DETAIL)
    assert ("start", "shared-d") not in world.calls
    assert world.removed == []
    if answer != "unknown-membership-and-a-file-row":  # that row ends only the user log's own membership
        assert "file-f" in state.membership_ids(world.namespace("my-drive"), GEN), "the user log's claim stands"
    state.close()


@pytest.mark.asyncio
async def test_control_a_duplicated_drive_event_is_idempotent(tmp_path, monkeypatch):
    world, path, state = await _nonmember_baseline(tmp_path, monkeypatch, "duplicate.sqlite")
    await _gain_membership_by_drive_event_only(world, state, DRIVE_EVENT, DRIVE_EVENT)
    assert _binding(state) == ("uncertain", "my-drive", None, ROOT_MEMBERSHIP_EVENT_DETAIL)
    # The same event replayed after the relocation began changes nothing.
    await world.run(state)
    assert _binding(state)[:3] == ("relocating", "my-drive", "shared-d") or _binding(state)[:2] == ("bound", "shared-d")
    world.logs["my-drive"].append(dict(DRIVE_EVENT))
    summary, state = await _converge(world, state, path)
    assert summary.authoritative_complete is True
    assert _binding(state) == ("bound", "shared-d", None, None)
    assert world.calls.count(("start", "shared-d")) <= 1
    assert state.get_progress(world.namespace("shared-d")).baseline_start_token == "shared-d@0"
    assert world.removed == []
    state.close()
