"""Verified removals under a resource restriction, and deferred removal probes (AIO-1167 R51 blind-final 1, 2).

Spec (accepted-spec AC-04:230, AC-05/06:172,242–244; Astra R51 blind-final adjudication). Through the
real coordinator over the ``_DriveWorld`` double, with every provider deferral the REAL provider-call
owner's answer:

1. A document under a standing resource restriction (a finite or an unrepresentable minimum) that is
   then explicitly trashed has its removal reconciled promptly through the claim-aware owner, with
   ZERO reads of the restricted document: our claim is retired, the content is suppressed when it was
   the last claim, and another connection's claim survives. The restriction itself is untouched, a
   later restoration is still not read before it lapses, and an ambiguous cross-stream move stays
   pending with no early probe.
2. A removal probe the provider defers is neither survival nor loss evidence. On the claimant and the
   unreadable-peer paths: a quota answer (429, quota 403) is the account's hold and stops the run; a
   503 with a named Retry-After is that document's restriction and the run goes on; nothing is
   acknowledged or probed again before the minimum, across a restart; reconciliation resumes after
   it. The run's own deadline opens no provider minimum; a malformed header keeps its bounded fallback
   and its diagnostic.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import StateStore
from test_account_hold_before_streams import provider_deferral
from test_document_restrictions import GEN, LONG, SENTINEL, _reads, _restriction, _world, clock, run  # noqa: F401
from test_gdrive_upgrade import _ClaimLedger, _DriveWorld, _ProviderHttpError
from test_root_evidence_r49 import real_deferral

FAR = "2999-01-01T00:00:00+00:00"


def _change(world, doc, drive="shared-a"):
    world.files[doc]["modifiedTime"] = "2026-10-01T00:00:00Z"
    world.logs.setdefault(drive, []).append({"fileId": doc, "file": dict(world.files[doc])})


def _trash(world, doc, drive="shared-a"):
    world.files[doc]["trashed"] = True
    world.logs.setdefault(drive, []).append({"fileId": doc, "file": dict(world.files[doc])})


def _owed(state, world, doc, drive="shared-a"):
    return state.has_owed_work(world.namespace(drive), GEN, doc)


def _owed_removal(state, world, doc, drive="shared-a"):
    row = state._db.execute(
        "SELECT failures FROM pending_work WHERE namespace=? AND generation=? AND item_key=? "
        "AND action='remove' AND acknowledged_at IS NULL AND superseded_at IS NULL",
        (world.namespace(drive), GEN, doc),
    ).fetchone()
    return None if row is None else int(row[0])


def _hold(state, world):
    return state.connection_hold(world.integration_id, GEN, "account")


# ------------------------------------------------------------------------------------------------ #
# 1. A verified removal is not suppressed by the document's resource restriction
# ------------------------------------------------------------------------------------------------ #

@pytest.mark.parametrize("header", [LONG, SENTINEL], ids=["finite", "unrepresentable"])
@pytest.mark.parametrize("other_claim", [False, True], ids=["last-claim", "overlap"])
@pytest.mark.asyncio
async def test_an_explicit_trash_under_a_restriction_is_reconciled_promptly_without_a_read(
    tmp_path, monkeypatch, clock, header, other_claim,
):
    world = _world(monkeypatch)
    world.ledger = _ClaimLedger()
    if other_claim:
        world.ledger.push("another-connection", "doc-a")
    state = StateStore(str(tmp_path / f"trash-{header[:3]}-{other_claim}.sqlite"))
    assert (await run(world, state)).authoritative_complete is True

    # doc-a changes and its read names a provider minimum: the document is restricted.
    _change(world, "doc-a")
    world.unreadable["doc-a"] = provider_deferral(503, header)
    await run(world, state)
    restriction = _restriction(state, world)
    assert restriction is not None

    # Before it expires, the drive reports doc-a trashed.
    _trash(world, "doc-a")
    world.calls.clear()
    world.pushed.clear()
    await run(world, state)

    assert _reads(world, "doc-a") == []  # not one read of the restricted document
    assert "doc-a" in world.removed  # reconciled through the claim-aware owner, this run
    assert (world.integration_id, "doc-a") in world.ledger.retired
    if other_claim:
        assert "doc-a" not in world.ledger.deleted  # another connection's valid claim survives
        assert world.ledger.claims["doc-a"] == {"another-connection"}
    else:
        assert "doc-a" in world.ledger.deleted  # the last claim: the content is suppressed
    assert not _owed(state, world, "doc-a") and "doc-a" not in world.pushed
    assert _restriction(state, world) == restriction  # the restriction itself is untouched
    state.close()


@pytest.mark.asyncio
async def test_a_restoration_after_the_removal_is_still_not_read_before_the_restriction_lapses(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "restore.sqlite"))
    assert (await run(world, state)).authoritative_complete is True
    _change(world, "doc-a")
    world.unreadable["doc-a"] = provider_deferral(503, LONG)
    await run(world, state)
    _trash(world, "doc-a")
    await run(world, state)
    assert "doc-a" in world.removed

    # Restored in Drive: a new upsert is owed, and still restricted.
    world.files["doc-a"]["trashed"] = False
    _change(world, "doc-a")
    world.unreadable.pop("doc-a")
    world.calls.clear()
    world.pushed.clear()
    held = await run(world, state)
    assert _reads(world, "doc-a") == [] and "doc-a" not in world.pushed
    assert held.failure_categories.get("provider_restricted_document") == 1
    assert _owed(state, world, "doc-a")

    clock.at += timedelta(days=4 * 365)  # past the ~3.2-year minimum
    await run(world, state)
    assert ("metadata", "doc-a") in world.calls and "doc-a" in world.pushed
    state.close()


def _two_stream_world(monkeypatch):
    world = _DriveWorld(folder_ids=["folder-r", "folder-s"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("folder-s", drive="shared-b", folder=True)
    world.put("doc-a", drive="shared-a", parent="folder-r")
    world.put("doc-b", drive="shared-a", parent="folder-r")
    world.put("doc-s", drive="shared-b", parent="folder-s")
    return world


@pytest.mark.asyncio
async def test_an_ambiguous_cross_stream_move_of_a_restricted_document_stays_pending_without_a_probe(
    tmp_path, monkeypatch, clock,
):
    world = _two_stream_world(monkeypatch)
    state = StateStore(str(tmp_path / "ambiguous.sqlite"))
    assert (await run(world, state)).authoritative_complete is True
    state.restrict_document(world.integration_id, GEN, "account", "doc-a", FAR, "provider_unavailable")

    # doc-a moves to the other selected drive: one log says removed, the other says present.
    world.move("doc-a", source="shared-a", destination="shared-b", parent="folder-s")
    world.calls.clear()
    for _ in range(3):
        await run(world, state)

    assert _reads(world, "doc-a") == []  # never probed while restricted
    assert "doc-a" not in world.removed  # never removed on an ambiguous move
    assert _owed_removal(state, world, "doc-a") is not None  # the removal is retained
    state.close()


# ------------------------------------------------------------------------------------------------ #
# 2. A deferred removal probe is routed to the provider-minimum owners
# ------------------------------------------------------------------------------------------------ #

QUOTA = [
    pytest.param(lambda: real_deferral(429, "3600"), id="429"),
    pytest.param(lambda: real_deferral(403, "3600", reason="rateLimitExceeded"), id="quota-403"),
]


async def _claimant_probe_world(tmp_path, monkeypatch, name):
    """doc-a moved to shared-b, which drained and claims it, while shared-a has not read its log:
    shared-a's removal will be weighed against shared-b's claim by probing doc-a."""
    world = _two_stream_world(monkeypatch)
    state = StateStore(str(tmp_path / f"{name}.sqlite"))
    assert (await run(world, state)).authoritative_complete is True
    world.move("doc-a", source="shared-a", destination="shared-b", parent="folder-s")
    # shared-a cannot read its log in this run (an ordinary stream-level deferral, no minimum).
    world.change_errors["shared-a"] = [
        ProviderDeferred("unavailable", not_before=None, category="provider_unavailable"),
    ]
    await run(world, state)
    assert "doc-a" in world.pushed  # shared-b took the move and claims doc-a
    return world, state


async def _unreadable_peer_probe_world(tmp_path, monkeypatch, name):
    """A selected root that never resolved leaves the roster unknown: a removal is settled only by
    probing the document itself."""
    world = _DriveWorld(file_ids=["file-u"], folder_ids=["folder-r"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("doc-a", drive="shared-a", parent="folder-r")
    world.put("doc-b", drive="shared-a", parent="folder-r")
    world.unreadable["file-u"] = _ProviderHttpError(404)
    state = StateStore(str(tmp_path / f"{name}.sqlite"))
    await run(world, state)
    assert "doc-a" in world.pushed
    world.logs.setdefault("shared-a", []).append({"fileId": "doc-a", "removed": True})
    return world, state


PATHS = [
    pytest.param(_claimant_probe_world, id="claimant"),
    pytest.param(_unreadable_peer_probe_world, id="unreadable-peer"),
]


@pytest.mark.parametrize("deferral", QUOTA)
@pytest.mark.parametrize("setup", PATHS)
@pytest.mark.asyncio
async def test_a_quota_answer_to_the_removal_probe_is_the_accounts_hold(tmp_path, monkeypatch, clock, setup, deferral):
    world, state = await setup(tmp_path, monkeypatch, "probe-quota")
    world.unreadable["doc-a"] = deferral()
    world.calls.clear()
    world.removed.clear()

    summary = await run(world, state)

    assert world.calls[-1] == ("metadata", "doc-a")  # nothing read after the quota answer
    assert summary.failure_categories.get("rate_limited") == 1
    assert _hold(state, world) is not None  # the account's hold
    assert _owed_removal(state, world, "doc-a") is not None and "doc-a" not in world.removed
    state.close()

    # A restart before the hold expires makes no provider call at all.
    state = StateStore(str(tmp_path / "probe-quota.sqlite"))
    world.calls.clear()
    await run(world, state)
    assert world.calls == []
    assert _owed_removal(state, world, "doc-a") is not None
    state.close()


@pytest.mark.parametrize("setup", PATHS)
@pytest.mark.asyncio
async def test_a_named_503_on_the_removal_probe_restricts_that_document_and_the_run_goes_on(
    tmp_path, monkeypatch, clock, setup,
):
    world, state = await setup(tmp_path, monkeypatch, "probe-503")
    world.unreadable["doc-a"] = provider_deferral(503, LONG)
    _change(world, "doc-b")  # independent work in the same run
    world.calls.clear()
    world.pushed.clear()
    world.removed.clear()

    summary = await run(world, state)

    assert _restriction(state, world) is not None  # the document's own minimum
    assert _hold(state, world) is None  # never an account hold
    assert "doc-b" in world.pushed  # resource-only: independent work continued
    assert _owed_removal(state, world, "doc-a") is not None and "doc-a" not in world.removed
    assert summary.failure_categories.get("provider_unavailable", 0) >= 1
    state.close()

    # Restart before the minimum: the removal is neither probed nor acknowledged.
    state = StateStore(str(tmp_path / "probe-503.sqlite"))
    world.calls.clear()
    await run(world, state)
    assert _reads(world, "doc-a") == []
    assert _owed_removal(state, world, "doc-a") is not None and "doc-a" not in world.removed

    # After the minimum, the probe is read again; doc-a is gone at the provider, so it is reconciled.
    clock.at += timedelta(days=4 * 365)
    world.unreadable.pop("doc-a")
    world.files.pop("doc-a")
    await run(world, state)
    assert ("metadata", "doc-a") in world.calls
    assert "doc-a" in world.removed and _owed_removal(state, world, "doc-a") is None
    state.close()


@pytest.mark.parametrize("setup", PATHS)
@pytest.mark.asyncio
async def test_the_runs_own_deadline_on_the_probe_opens_no_provider_minimum(tmp_path, monkeypatch, clock, setup):
    world, state = await setup(tmp_path, monkeypatch, "probe-deadline")
    world.unreadable["doc-a"] = ProviderDeferred("run budget spent", not_before=None, category="dispatch_deadline")
    world.removed.clear()

    summary = await run(world, state)

    assert summary.failure_categories.get("dispatch_deadline") == 1
    assert _hold(state, world) is None and _restriction(state, world) is None
    assert _owed_removal(state, world, "doc-a") == 0  # untouched: not a failure
    assert "doc-a" not in world.removed
    state.close()


@pytest.mark.parametrize("setup", PATHS)
@pytest.mark.asyncio
async def test_a_malformed_retry_after_on_the_probe_keeps_its_bounded_fallback_and_diagnostic(
    tmp_path, monkeypatch, clock, setup,
):
    world, state = await setup(tmp_path, monkeypatch, "probe-malformed")
    world.unreadable["doc-a"] = real_deferral(503, "soon")
    world.removed.clear()

    summary = await run(world, state)

    assert summary.failure_categories.get("retry_after_malformed") == 1
    assert _restriction(state, world) is None  # no provider-named minimum to keep
    assert _hold(state, world) is None
    assert _owed_removal(state, world, "doc-a") == 1  # one bounded-backoff failure, still owed
    assert "doc-a" not in world.removed
    state.close()
