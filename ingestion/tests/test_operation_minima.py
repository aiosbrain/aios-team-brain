"""Folder-listing and change-page provider minima survive a generation transition (AIO-1167 final review A3).

Spec (accepted-spec AC-04; Astra adjudication A3). A valid provider-named Retry-After on a folder
`files.list` or on a drive's change-page read is journaled through the existing account/resource
restriction owner under a STABLE operation key (`list-folder:<folder>`, `changes:<drive>`) — never a
page token, cursor or generation — published in the retained restriction sections, and honoured before
dispatch. Through the real coordinator over ``_DriveWorld``:

  * a scope edit (a new selection generation whose brain progress keeps only the restriction sections)
    with a FRESH SQLite store does not waive it: no call to the restricted operation before the minimum,
    while an independent folder is still listed; once it passes, the operation proceeds;
  * a missing or malformed Retry-After stays attempt-local: no durable operation restriction.
"""

from __future__ import annotations

import json
from datetime import timedelta

import pytest

from aios_ingest.connector_state import RESTRICTION_KEYS
from aios_ingest.state import StateStore
from test_document_restrictions import GEN, clock, run  # noqa: F401 (clock is a fixture)
from test_gdrive_upgrade import _DriveWorld
from test_root_evidence_r49 import real_deferral

DRIVE = "shared-a"
LONG = "86400"  # one day, a valid delay-seconds


class _FailingCalls(list):
    """The world's call log, raising ``failures[call]`` (once each) exactly when that call is made."""

    def __init__(self, failures):
        super().__init__()
        self.failures = failures

    def append(self, item):
        super().append(item)
        pending = self.failures.get(item)
        if pending:
            raise pending.pop(0)


def _world(monkeypatch):
    world = _DriveWorld(folder_ids=["folder-a", "folder-b"]).install(monkeypatch)
    world.put("folder-a", drive=DRIVE, folder=True)
    world.put("doc-a", drive=DRIVE, parent="folder-a")
    world.put("folder-b", drive=DRIVE, folder=True)
    world.put("doc-b", drive=DRIVE, parent="folder-b")
    return world


def _restricted(state, world, resource):
    return state.document_restrictions(world.integration_id, world.generation, "account").get(resource)


def _published(world, resource):
    items = (world.progress.get("document_restrictions") or {}).get("items") or []
    return [item for item in items if item.get("id") == resource]


def _transition(world, monkeypatch, tmp_path, name):
    """A scope edit: the brain clears the streams and keeps only the restriction sections; the sidecar
    restarts with a fresh store."""
    world.generation += 1
    world.config["folderIds"] = list(world.config["folderIds"])  # same selection, new generation
    world.progress = {key: json.loads(json.dumps(world.progress[key])) for key in RESTRICTION_KEYS if key in world.progress}
    return StateStore(str(tmp_path / f"{name}.sqlite"))


@pytest.mark.asyncio
async def test_a_folder_listing_minimum_survives_a_generation_transition_and_fresh_store(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    world.calls = _FailingCalls({("list", DRIVE, "folder-a"): [real_deferral(503, LONG)]})
    state = StateStore(str(tmp_path / "first.sqlite"))
    outcome = await run(world, state)
    assert outcome.authoritative_complete is False
    assert _restricted(state, world, "list-folder:folder-a") is not None  # the folder operation, journaled
    assert _published(world, "list-folder:folder-a")  # in the retained restriction section
    state.close()

    fresh = _transition(world, monkeypatch, tmp_path, "transition")
    world.calls = _FailingCalls({})
    outcome = await run(world, fresh)
    assert ("list", DRIVE, "folder-a") not in world.calls  # never read early
    assert ("list", DRIVE, "folder-b") in world.calls  # independent work still eligible
    assert outcome.authoritative_complete is False

    clock.at += timedelta(seconds=int(LONG) + 60)
    world.calls = _FailingCalls({})
    for _ in range(3):
        outcome = await run(world, fresh)
        if outcome.authoritative_complete:
            break
    assert ("list", DRIVE, "folder-a") in world.calls
    assert outcome.authoritative_complete is True
    fresh.close()


@pytest.mark.asyncio
async def test_a_change_page_minimum_survives_a_generation_transition_and_fresh_store(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "changes.sqlite"))
    assert (await run(world, state)).authoritative_complete is True
    world.logs.setdefault(DRIVE, []).append({"fileId": "doc-a", "file": dict(world.files["doc-a"])})
    world.change_errors[DRIVE] = [real_deferral(503, LONG)]
    await run(world, state)
    assert _restricted(state, world, f"changes:{DRIVE}") is not None
    assert _published(world, f"changes:{DRIVE}")
    state.close()

    fresh = _transition(world, monkeypatch, tmp_path, "changes-transition")
    world.calls.clear()
    outcome = await run(world, fresh)
    assert not [call for call in world.calls if call[0] == "changes"]  # no change page read early
    assert outcome.authoritative_complete is False

    clock.at += timedelta(seconds=int(LONG) + 60)
    world.calls.clear()
    for _ in range(3):
        outcome = await run(world, fresh)
        if outcome.authoritative_complete:
            break
    assert [call for call in world.calls if call[0] == "changes"]
    fresh.close()


@pytest.mark.asyncio
async def test_a_listing_minimum_survives_a_same_account_reconnect_that_keeps_the_store(
    tmp_path, monkeypatch, clock,
):
    """A same-account reconnect is a new generation for the SAME verified account and the same local
    store: the operation minimum is the account's resource evidence, never generation authority."""
    world = _world(monkeypatch)
    world.calls = _FailingCalls({("list", DRIVE, "folder-a"): [real_deferral(503, LONG)]})
    state = StateStore(str(tmp_path / "reconnect.sqlite"))
    await run(world, state)
    assert _restricted(state, world, "list-folder:folder-a") is not None

    world.generation += 1  # reconnect: new generation, same account, same store
    world.progress = {key: json.loads(json.dumps(world.progress[key])) for key in RESTRICTION_KEYS if key in world.progress}
    world.calls = _FailingCalls({})
    await run(world, state)
    assert ("list", DRIVE, "folder-a") not in world.calls
    assert ("list", DRIVE, "folder-b") in world.calls
    state.close()


@pytest.mark.asyncio
async def test_a_listing_minimum_whose_acknowledgment_was_lost_is_honoured_from_the_brain(
    tmp_path, monkeypatch, clock,
):
    """The checkpoint carrying the minimum is stored by the brain but its answer is lost. A fresh store
    after a scope edit adopts it from the acknowledged progress: still no early listing."""
    from aios_ingest.brain_client import BrainError

    world = _world(monkeypatch)
    world.calls = _FailingCalls({("list", DRIVE, "folder-a"): [real_deferral(503, LONG)]})

    def stored_then_lost(progress):
        items = (progress.get("document_restrictions") or {}).get("items") or []
        if not any(item.get("id") == "list-folder:folder-a" for item in items):
            return None
        world.revision += 1
        world.progress = json.loads(json.dumps(progress))
        return BrainError(503, "server_error", "acknowledgment lost")

    world.checkpoint_faults.append(stored_then_lost)
    state = StateStore(str(tmp_path / "lost.sqlite"))
    try:
        await run(world, state)
    except Exception:  # noqa: BLE001 — however the lost acknowledgment surfaced
        pass
    assert stored_then_lost not in world.checkpoint_faults  # the brain really stored it
    assert _published(world, "list-folder:folder-a")
    state.close()

    fresh = _transition(world, monkeypatch, tmp_path, "lost-transition")
    world.calls = _FailingCalls({})
    await run(world, fresh)
    assert ("list", DRIVE, "folder-a") not in world.calls
    fresh.close()


@pytest.mark.asyncio
async def test_a_listing_minimum_is_neither_inherited_nor_erased_by_another_account_and_applies_on_return(
    tmp_path, monkeypatch, clock,
):
    """A→B→A, by the account-transition pattern of ``test_restriction_lifetime``: the operation minimum
    is account-bound resource evidence. Account B does not inherit it (B lists the folder) and does not
    erase it (it is carried in ``retained_restrictions``); back on account A it applies again."""
    from test_restriction_lifetime import _published_ids, transition, use_account

    world = _world(monkeypatch)
    world.calls = _FailingCalls({("list", DRIVE, "folder-a"): [real_deferral(503, LONG)]})
    state = StateStore(str(tmp_path / "a-b-a.sqlite"))
    await run(world, state)
    assert "list-folder:folder-a" in _published_ids(world, "account")

    transition(world)
    use_account(world, monkeypatch, "account-b")
    world.calls = _FailingCalls({})
    for _ in range(2):
        await run(world, state)
    assert ("list", DRIVE, "folder-a") in world.calls  # B: no inheritance
    assert "list-folder:folder-a" in _published_ids(world, "account")  # and not erased for A

    transition(world)
    use_account(world, monkeypatch, "account")
    world.calls = _FailingCalls({})
    for _ in range(2):
        await run(world, state)
    assert ("list", DRIVE, "folder-a") not in world.calls  # A again: the minimum applies
    assert ("list", DRIVE, "folder-b") in world.calls
    assert "list-folder:folder-a" in _published_ids(world, "account")
    state.close()


@pytest.mark.parametrize("header", [None, "soon"], ids=["missing", "malformed"])
@pytest.mark.asyncio
async def test_a_listing_or_change_answer_naming_no_minimum_stays_attempt_local(
    tmp_path, monkeypatch, clock, header,
):
    world = _world(monkeypatch)
    world.calls = _FailingCalls({("list", DRIVE, "folder-a"): [real_deferral(503, header)]})
    state = StateStore(str(tmp_path / f"local-{header}.sqlite"))
    await run(world, state)
    assert _restricted(state, world, "list-folder:folder-a") is None
    world.calls = _FailingCalls({})
    clock.at += timedelta(minutes=5)  # past the attempt-local fallback
    await run(world, state)
    world.change_errors[DRIVE] = [real_deferral(503, header)]
    world.logs.setdefault(DRIVE, []).append({"fileId": "doc-b", "file": dict(world.files["doc-b"])})
    await run(world, state)
    assert _restricted(state, world, f"changes:{DRIVE}") is None
    state.close()
