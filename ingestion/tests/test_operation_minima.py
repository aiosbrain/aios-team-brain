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
