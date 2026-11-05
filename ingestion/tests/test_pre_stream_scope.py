"""Pre-stream provider answers are scoped to the operation they were read for (AIO-1167 R50 F3).

Spec (Astra R49 adjudication, finding 3). Timing before a stream exists does not make an answer the
account's. Every deferral below is the REAL provider-call owner's answer (``provider_deferral`` /
``real_deferral``), driven through the real coordinator over ``_DriveWorld``:

  * a quota answer — 429, or a 403 naming a rate-limit reason — on a root read is the account's hold:
    no further account call (R47 F5, kept);
  * a root metadata 503 with a long Retry-After is THAT root's: no account hold, its named minimum is
    kept, it stays an unresolved obligation, a readable sibling root's stream still runs, and the
    root is not read again before its minimum — no early retry, no inferred absence;
  * a start-token 503 or timeout is THAT stream's: it cannot enumerate without its token, while an
    independent stream runs; a named minimum is kept for the token only;
  * a relocation re-read answered 503 defers that root alone;
  * a service-account identity 503 defers the connection's prerequisite without an account hold.
"""

from __future__ import annotations

import pytest

from aios_ingest.config import Connection
from aios_ingest.scheduler import _poll_job
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import StateStore
from test_gdrive_poll_reporting import (  # noqa: F401 (brain is a fixture)
    INTEGRATION, SETTINGS, Brain, acquired_execution, brain, drive_identity, row,
)
from test_gdrive_upgrade import _DriveWorld, _ProviderHttpError
from test_root_evidence_r49 import real_deferral

GEN = 9
LONG = "99999999"


def _hold(state, world):
    return state.connection_hold(world.integration_id, GEN, "account")


def _restrictions(state, world):
    return set(state.document_restrictions(world.integration_id, GEN, "account"))


def _file_world(monkeypatch):
    world = _DriveWorld(file_ids=["file-x", "file-y"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("file-y", drive="shared-a")
    return world


@pytest.mark.parametrize("deferral", [
    lambda: real_deferral(429, LONG),
    lambda: real_deferral(403, LONG, reason="userRateLimitExceeded"),
], ids=["429", "403-rate-limit"])
@pytest.mark.asyncio
async def test_a_quota_answer_on_initial_root_binding_is_the_accounts_hold(tmp_path, monkeypatch, deferral):
    world = _file_world(monkeypatch)
    world.unreadable["file-x"] = deferral()
    state = StateStore(str(tmp_path / "quota.sqlite"))

    summary = await world.run(state)

    assert summary.failure_categories.get("rate_limited") == 1
    assert _hold(state, world) is not None
    assert ("metadata", "file-y") not in world.calls  # no further account call after the quota answer
    state.close()


@pytest.mark.asyncio
async def test_a_root_503_with_a_long_retry_after_defers_that_root_alone(tmp_path, monkeypatch):
    world = _file_world(monkeypatch)
    world.unreadable["file-x"] = real_deferral(503, LONG)
    state = StateStore(str(tmp_path / "root-503.sqlite"))

    summary = await world.run(state)

    assert _hold(state, world) is None  # never an account hold
    assert "rate_limited" not in summary.failure_categories
    assert summary.failure_categories.get("provider_unavailable") == 1
    assert "file-x" in _restrictions(state, world)  # the root's own named minimum
    binding = state.root_obligations(world.integration_id, GEN)[("file", "file-x")]
    assert binding.status == "unresolved" and "deferred" in (binding.detail or "")
    assert "file-y" in world.pushed  # the readable sibling root's stream ran
    assert summary.authoritative_complete is False and world.reconciled == []  # no inferred absence
    assert any(item["id"] == "file-x" for item in world.progress["document_restrictions"]["items"])

    # No early retry of the deferred root, on this state or a fresh one rebuilt from the brain.
    world.unreadable.pop("file-x")
    for rebuilt in (state, StateStore(str(tmp_path / "root-503-fresh.sqlite"))):
        world.calls.clear()
        again = await world.run(rebuilt)
        assert ("metadata", "file-x") not in world.calls
        assert again.authoritative_complete is False and world.reconciled == []
    state.close()


def _two_stream_world(monkeypatch):
    world = _DriveWorld(folder_ids=["folder-r", "folder-s"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("doc-r", drive="shared-a", parent="folder-r")
    world.put("folder-s", drive="shared-b", folder=True)
    world.put("doc-s", drive="shared-b", parent="folder-s")
    return world


@pytest.mark.parametrize("answer", ["503-long", "timeout"])
@pytest.mark.asyncio
async def test_a_start_token_deferral_isolates_that_stream(tmp_path, monkeypatch, answer):
    world = _two_stream_world(monkeypatch)
    world.token_errors["shared-a"] = (
        real_deferral(503, LONG) if answer == "503-long"
        else ProviderDeferred("start token timed out", not_before=None, category="provider_timeout")
    )
    state = StateStore(str(tmp_path / f"start-{answer}.sqlite"))

    summary = await world.run(state)

    assert _hold(state, world) is None
    assert "rate_limited" not in summary.failure_categories
    assert ("start", "shared-b") in world.calls and "doc-s" in world.pushed  # the independent stream ran
    assert not any(call[:2] == ("list", "shared-a") for call in world.calls)  # no token, no enumeration
    assert "doc-r" not in world.pushed
    assert summary.authoritative_complete is False and world.reconciled == []
    restricted = "start-token:shared-a" in _restrictions(state, world)
    assert restricted is (answer == "503-long")  # a named minimum only; a timeout stays attempt-local

    world.token_errors.clear()
    world.calls.clear()
    await world.run(state)
    if answer == "503-long":
        assert ("start", "shared-a") not in world.calls  # not asked for before its minimum
    else:
        assert ("start", "shared-a") in world.calls  # a timeout is simply retried
    state.close()


@pytest.mark.asyncio
async def test_a_relocation_reread_answered_503_defers_that_root_alone(tmp_path, monkeypatch):
    world = _DriveWorld(file_ids=["file-x", "file-y"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("file-y", drive="shared-a")
    state = StateStore(str(tmp_path / "relocation.sqlite"))
    assert (await world.run(state)).authoritative_complete is True

    # file-x moves to a Shared Drive whose change log cannot be opened: it is relocating, and once its
    # destination's stream is recorded without a token, every run re-reads where it is now.
    world.token_errors["shared-b"] = _ProviderHttpError(403)
    world.move("file-x", source="shared-a", destination="shared-b")
    await world.run(state)  # the change page reads file-x elsewhere: relocating
    binding = state.root_obligations(world.integration_id, GEN)[("file", "file-x")]
    assert binding.status == "relocating"
    await world.run(state)  # the destination's stream is recorded, its start token unavailable

    world.unreadable["file-x"] = real_deferral(503, LONG)
    world.calls.clear()
    summary = await world.run(state)

    assert _hold(state, world) is None
    assert "file-x" in _restrictions(state, world)
    assert summary.failure_categories.get("provider_unavailable") == 1
    assert any(call[:2] == ("changes", "shared-a") for call in world.calls)  # shared-a still ran
    assert state.root_obligations(world.integration_id, GEN)[("file", "file-x")].status == "relocating"

    world.calls.clear()
    await world.run(state)
    assert ("metadata", "file-x") not in world.calls  # not re-read before its minimum
    state.close()


@pytest.mark.asyncio
async def test_a_service_account_identity_503_defers_the_prerequisite_without_an_account_hold(
    tmp_path, brain, monkeypatch,
):
    state = StateStore(str(tmp_path / "identity.sqlite"))
    b = brain(Brain(
        rows=[row(auth_mode="service_account")],
        acquire=acquired_execution("service_account", serviceAccountStatus="pending"),
    ))
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", drive_identity(real_deferral(503, LONG)))
    connection = Connection("local-docs", "gdrive", options={"service_account_key_path": "/local/key.json"})

    await _poll_job(SETTINGS, connection, state)

    [report] = b.reports()
    assert report["integrationId"] == INTEGRATION
    assert report["error"] == "provider_unavailable"
    assert report["failed"] == 0 and report["skipped"] == 1
    assert state._db.execute("SELECT count(*) FROM connection_holds").fetchone()[0] == 0
    assert [r[0] for r in state._db.execute("SELECT provider_id FROM document_restrictions")] == [
        "prerequisite:service-account-identity",
    ]
    state.close()
