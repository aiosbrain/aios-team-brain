"""A provider minimum outlives a selection generation (AIO-1167 R50 F1).

Spec (Astra R49 adjudication, finding 1; R48 F1/F4). Provider-minimum lifetime is bound to the verified
connection/account and, for a resource, its stable provider id — never to a selection generation.
Execution, cursor, membership and publication authority stay generation-bound. Through the real
coordinator over ``_DriveWorld``, with each transition applied to the brain's progress exactly as the
authority trigger does it (``postgres/migrations/20261031140000_gdrive_restriction_generation_lifetime.sql``:
a new generation, progress reset to the three restriction sections only — proven against real
Postgres in ``test/datamechanics/gdrive-authority.datamechanics.test.ts``):

  * a long or unrepresentable document minimum survives an added root, an empty selection followed
    by reselection, and a same-account reconnect: no read, push or completion before it passes, and
    the new generation's published section still names it;
  * a deselected document keeps its minimum without counting as selected backlog, and reselecting
    it cannot read it early;
  * another verified account neither inherits the original account's minimum nor erases it — the
    evidence is carried in ``retained_restrictions`` and applies again when the original returns;
  * an account hold survives a scope edit and a same-account reconnect.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

import aios_ingest.gdrive_sync as sync
from aios_ingest.state import StateStore
from test_account_hold_before_streams import provider_deferral
from test_document_restrictions import (  # noqa: F401 (clock is a fixture)
    LONG, SENTINEL, _reads, _restrict_after_seven_failures, _world, clock, run,
)

RETAINED = ("account_hold", "document_restrictions", "retained_restrictions")


def transition(world, **config) -> None:
    """The brain's authority trigger on a scope or credential change (R50 migration): a new
    generation and revision, generation-specific progress reset, restriction sections kept."""
    world.generation += 1
    world.revision += 1
    world.config.update(config)
    world.progress = {key: value for key, value in world.progress.items() if key in RETAINED}


def use_account(world, monkeypatch, account: str) -> None:
    """The broker's verified account for the next runs (a reconnect to ``account``)."""

    async def broker(self, execution):
        return {"access_token": "memory", "account": {"subject": account}}

    monkeypatch.setattr(sync.BrainClient, "broker_gdrive_access_token", broker)
    world.config["authenticatedAccountId"] = account


def _published_ids(world, account: str = "account") -> list[str]:
    section = world.progress.get("document_restrictions") or {}
    if section.get("credential") == account:
        return [item["id"] for item in section.get("items") or []]
    retained = (world.progress.get("retained_restrictions") or {}).get(account) or {}
    return [item["id"] for item in retained.get("items") or []]


@pytest.mark.parametrize("header", [LONG, SENTINEL], ids=["long", "unrepresentable"])
@pytest.mark.parametrize("change", ["add-root", "empty-then-reselect", "same-account-reconnect"])
@pytest.mark.asyncio
async def test_a_generation_change_cannot_waive_a_document_minimum(tmp_path, monkeypatch, clock, header, change):
    world = _world(monkeypatch)
    world.put("folder-z", drive="shared-a", folder=True)
    world.put("doc-z", drive="shared-a", parent="folder-z")
    path = str(tmp_path / "lifetime.sqlite")
    state = StateStore(path)
    await _restrict_after_seven_failures(world, state, clock, header)
    assert _published_ids(world) == ["doc-a"]
    first_generation = world.generation

    if change == "add-root":
        transition(world, folderIds=["folder-r", "folder-z"])
    elif change == "empty-then-reselect":
        transition(world, folderIds=[], selectionState="empty")
        await run(world, state)
        assert _published_ids(world) == ["doc-a"]  # the empty generation carried it
        transition(world, folderIds=["folder-r"], selectionState="selected")
    else:
        transition(world)  # a reconnect to the SAME account: new credential revision, new generation
    assert world.generation > first_generation

    world.calls.clear()
    world.pushed.clear()
    for _ in range(3):
        clock.at += timedelta(days=30)
        outcome = await run(world, state, rearm=True)
        assert outcome.authoritative_complete is False
    assert ("list", "shared-a", "folder-r") in world.calls  # the new generation re-enumerated it
    assert _reads(world, "doc-a") == [] and "doc-a" not in world.pushed
    assert "doc-b" in world.pushed  # the independent document progressed in the new generation
    assert _published_ids(world) == ["doc-a"]
    assert world.progress["document_restrictions"]["generation"] == world.generation
    state.close()

    # A fresh state file for the new generation restores it from the brain's progress alone.
    fresh = StateStore(str(tmp_path / "fresh.sqlite"))
    world.calls.clear()
    for _ in range(2):
        await run(world, fresh, rearm=True)
    assert _reads(world, "doc-a") == []
    fresh.close()


@pytest.mark.asyncio
async def test_a_deselected_document_keeps_its_minimum_and_reselection_cannot_read_early(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    world.put("folder-z", drive="shared-a", folder=True)
    world.put("doc-z", drive="shared-a", parent="folder-z")
    state = StateStore(str(tmp_path / "deselect.sqlite"))
    await _restrict_after_seven_failures(world, state, clock, LONG)

    # Deselected: folder-r leaves the selection.
    transition(world, folderIds=["folder-z"])
    for _ in range(2):
        deselected = await run(world, state)
    assert "provider_restricted_document" not in deselected.failure_categories  # not selected backlog
    assert not state.has_owed_work(world.namespace("shared-a"), world.generation, "doc-a")
    assert _published_ids(world) == ["doc-a"]  # but the minimum stands

    # Reselected: still not read before the minimum passes.
    transition(world, folderIds=["folder-r", "folder-z"])
    world.calls.clear()
    world.pushed.clear()
    for _ in range(2):
        await run(world, state, rearm=True)
    assert ("list", "shared-a", "folder-r") in world.calls
    assert _reads(world, "doc-a") == [] and "doc-a" not in world.pushed and "doc-b" in world.pushed
    state.close()


@pytest.mark.asyncio
async def test_another_account_neither_inherits_nor_erases_the_original_accounts_minimum(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "accounts.sqlite"))
    await _restrict_after_seven_failures(world, state, clock, LONG)

    # Reconnected to ANOTHER account: it does not inherit account's minimum…
    transition(world)
    use_account(world, monkeypatch, "account-b")
    world.calls.clear()
    world.pushed.clear()
    for _ in range(2):
        await run(world, state)
    assert "doc-a" in world.pushed  # account-b reads it: no inheritance
    # …and does not erase it: carried forward unchanged for the original account.
    assert "document_restrictions" not in world.progress or world.progress[
        "document_restrictions"]["credential"] == "account-b"
    assert _published_ids(world, "account") == ["doc-a"]

    # Back to the original account: the minimum applies again.
    transition(world)
    use_account(world, monkeypatch, "account")
    world.calls.clear()
    world.pushed.clear()
    for _ in range(2):
        await run(world, state, rearm=True)
    assert _reads(world, "doc-a") == [] and "doc-a" not in world.pushed and "doc-b" in world.pushed
    assert _published_ids(world, "account") == ["doc-a"]
    state.close()


@pytest.mark.parametrize("change", ["scope-edit", "same-account-reconnect"])
@pytest.mark.asyncio
async def test_an_account_hold_survives_a_scope_edit_and_a_same_account_reconnect(
    tmp_path, monkeypatch, clock, change,
):
    world = _world(monkeypatch)
    world.token_errors["shared-a"] = provider_deferral(429, LONG)
    state = StateStore(str(tmp_path / "hold.sqlite"))
    held = await run(world, state)
    assert held.failure_categories.get("rate_limited") == 1
    assert world.progress["account_hold"]["credential"] == "account"
    world.token_errors.clear()

    if change == "scope-edit":
        world.put("folder-z", drive="shared-a", folder=True)
        transition(world, folderIds=["folder-r", "folder-z"])
    else:
        transition(world)
    world.calls.clear()
    for rebuilt in (state, StateStore(str(tmp_path / "hold-fresh.sqlite"))):
        clock.at += timedelta(days=1)
        await run(world, rebuilt, rearm=True)
        assert world.calls == []  # no provider call of the account before its minimum
    assert world.progress["account_hold"]["credential"] == "account"
    state.close()
