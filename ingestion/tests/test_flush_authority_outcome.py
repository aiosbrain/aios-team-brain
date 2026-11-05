"""A terminal authority refusal at an orderly-return checkpoint keeps the run's outcome (AIO-1167
R51 L1).

Spec (Astra R51 Low adjudication, L1). When publishing unpublished hold or restriction evidence at
an orderly return is refused with ``stale_execution`` or ``connection_unavailable``, the run's
accumulated summary is NOT replaced by a generic ``coordinator_error``: the hold category, any
progress made, the authority code (once) and the applicable unpublished categories are reported;
an existing cause is kept beside it. The local journal keeps the evidence; nothing further is read
or sent under the lost authority; the lease is still released. Scheduled and manual reports carry
that summary, status follows the ordinary classification, and a connection paused or disconnected
meanwhile is still not reported.
"""

from __future__ import annotations

import pytest

from aios_ingest.brain_client import BrainError, GdriveExecution
from aios_ingest.config import Connection
from aios_ingest.engine import IngestSummary
from aios_ingest.gdrive_sync import _flush_restriction_evidence
from aios_ingest.scheduler import _gdrive_outcome_status, _manual_gdrive_job, _poll_job
from aios_ingest.state import StateStore
from test_document_restrictions import _world as _folder_world
from test_document_restrictions import clock, run  # noqa: F401 (clock is a fixture)
from test_gdrive_poll_reporting import MANUAL_CLAIM, SETTINGS, Brain, brain, row  # noqa: F401 (brain is a fixture)
from test_gdrive_upgrade import _DriveWorld, _ProviderHttpError
from test_restriction_publication_recovery import _two_root_world
from test_root_evidence_r49 import real_deferral

GEN = 9
LONG = "99999999"
CODES = ["stale_execution", "connection_unavailable"]


def _refuse(code, refusals):
    def fault(_payload):
        refusals.append(1)
        return BrainError(409, code, "refused")
    return fault


async def _refused_standing_hold(world, state, monkeypatch, code):
    """A hold and a resource minimum kept only locally, then a reacquisition whose repair is refused."""
    import aios_ingest.gdrive_sync as sync

    world.unreadable["file-a"] = real_deferral(503, LONG)
    world.unreadable["file-b"] = real_deferral(429, "3600")
    world.checkpoint_faults.append(lambda _payload: BrainError(503, "server_error", "brain unavailable"))
    await world.run(state)
    assert "account_hold" not in world.progress

    released: list[int] = []

    async def release(self, execution):
        released.append(execution.fence)

    monkeypatch.setattr(sync.BrainClient, "release_gdrive_execution", release)
    refusals: list[int] = []
    later: list[int] = []
    world.checkpoint_faults.extend([_refuse(code, refusals), lambda _payload: later.append(1)])
    revision = world.revision
    world.calls.clear()
    summary = await world.run(state)
    return summary, released, refusals, later, revision


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_a_terminal_refusal_at_standing_hold_repair_keeps_the_hold_outcome(tmp_path, monkeypatch, clock, code):
    world = _two_root_world(monkeypatch)
    state = StateStore(str(tmp_path / f"standing-{code}.sqlite"))

    summary, released, refusals, later, revision = await _refused_standing_hold(world, state, monkeypatch, code)

    assert summary.failure_categories == {
        "rate_limited": 1, code: 1, "account_hold_unpublished": 1, "document_restriction_unpublished": 1,
    }
    assert "coordinator_error" not in summary.failure_categories
    assert summary.skipped == 1 and summary.failed == 1
    assert world.calls == []  # no provider read under the hold or after the refusal
    assert refusals == [1] and later == [] and world.revision == revision  # no later checkpoint
    assert released  # the lease is still released
    assert state.connection_hold(world.integration_id, GEN, "account") is not None  # kept locally
    assert "file-a" in state.document_restrictions(world.integration_id, GEN, "account")
    assert "account_hold" not in world.progress  # never claimed published
    state.close()


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_scheduled_and_manual_reports_carry_the_hold_outcome_not_a_coordinator_error(
    tmp_path, monkeypatch, clock, brain, code,
):
    world = _two_root_world(monkeypatch)
    state = StateStore(str(tmp_path / f"report-{code}.sqlite"))
    summary, *_ = await _refused_standing_hold(world, state, monkeypatch, code)

    async def the_run(_settings, _connection, _state):
        return summary

    monkeypatch.setattr("aios_ingest.scheduler.run_gdrive_stream", the_run)
    expected_error = ", ".join(sorted(summary.failure_categories))
    integration = summary.integration_id
    connection = Connection("local-docs", "gdrive", options={"integration_id": integration})

    # Scheduled: the connection is still enabled when re-read, so the outcome is reported as is.
    scheduled = brain(Brain(rows=[row(integration_id=integration)]))
    await _poll_job(SETTINGS, connection, state)
    [report] = scheduled.reports()
    assert report["error"] == expected_error and "coordinator_error" not in report["error"]
    assert report["status"] == _gdrive_outcome_status(summary)
    assert (report["failed"], report["skipped"]) == (1, 1)

    # Manual (Run now / Retry): the claimed request completes with the same outcome.
    manual = brain(Brain(rows=[row(integration_id=integration)], claim=MANUAL_CLAIM))
    await _manual_gdrive_job(SETTINGS, [], state)
    [completion] = manual.reports()
    assert completion["error"] == expected_error and completion["status"] == _gdrive_outcome_status(summary)

    # Paused or disconnected meanwhile: the scheduled re-read still reports nothing.
    paused = brain(Brain(rows=[
        [row("enabled", integration_id=integration)], [row("disabled", integration_id=integration)],
    ]))
    await _poll_job(SETTINGS, connection, state)
    assert paused.reports() == []
    state.close()


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_a_terminal_refusal_of_the_drain_hold_checkpoint_keeps_progress_and_the_hold(
    tmp_path, monkeypatch, clock, code,
):
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / f"drain-{code}.sqlite"))
    assert (await run(world, state)).authoritative_complete is True

    for doc in ("doc-a", "doc-b"):  # doc-a drains first, then doc-b's read is the quota answer
        world.files[doc]["modifiedTime"] = "2026-10-01T00:00:00Z"
        world.logs["shared-a"].append({"fileId": doc, "file": dict(world.files[doc])})
    world.unreadable["doc-b"] = real_deferral(429, "3600")
    refusals: list[int] = []
    later: list[int] = []

    def refuse_hold(payload):
        if refusals:
            later.append(1)
            return None
        if payload.get("account_hold"):
            refusals.append(1)
            return BrainError(409, code, "refused")
        return None

    world.checkpoint_faults.extend([refuse_hold] * 5)
    world.pushed.clear()
    world.calls.clear()
    summary = await run(world, state)

    assert "doc-a" in world.pushed and summary.created + summary.updated >= 1  # progress kept
    assert summary.failed == 1  # no earlier run charge: the refusal is this run's one failure
    assert summary.failure_categories.get("rate_limited") == 1
    assert summary.failure_categories.get(code) == 1
    assert summary.failure_categories.get("account_hold_unpublished") == 1
    assert "coordinator_error" not in summary.failure_categories
    assert _gdrive_outcome_status(summary) == "partial"  # progress beside the refusal
    assert world.calls[-1] == ("metadata", "doc-b")  # nothing read after the quota answer
    assert refusals == [1] and later == []  # and nothing sent after the refusal
    assert state.connection_hold(world.integration_id, GEN, "account") is not None
    state.close()


class _RefusingClient:
    def __init__(self, code):
        self.code, self.sent = code, 0

    def gdrive_progress_uncertain(self, _execution):
        return False

    async def checkpoint_gdrive_execution(self, _execution, _payload):
        self.sent += 1
        raise BrainError(409, self.code, "refused")


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_the_end_of_run_flush_keeps_accumulated_progress_and_an_existing_cause(tmp_path, code):
    state = StateStore(str(tmp_path / f"flush-{code}.sqlite"))
    state.hold_connection("conn", 2, "account", "2099-01-01T00:00:00+00:00", "rate_limited")
    execution = GdriveExecution("conn", 2, 1, "owner", "later", "scope", {}, progress={})

    # No earlier cause: the accumulated progress stays, the refusal is added once, nothing raises.
    client = _RefusingClient(code)
    total = IngestSummary("docs", created=3, updated=1, failure_categories={"provider_unavailable": 1})
    await _flush_restriction_evidence(client, execution, state, "account", total)
    assert (total.created, total.updated) == (3, 1)
    assert total.failure_categories == {"provider_unavailable": 1, code: 1, "account_hold_unpublished": 1}
    assert total.failed == 1 and client.sent == 1

    # An existing nonterminal cause stays reported beside the flush's authority code — and the one
    # terminating run it already charged is not charged again (R51 Note A).
    cause = BrainError(503, "server_error", "brain unavailable")
    caused = IngestSummary("docs", failed=1, failure_categories={"server_error": 1})
    await _flush_restriction_evidence(
        _RefusingClient(code), execution, state, "account", caused, cause=cause,
        run_failure_counted=True,  # the caller already charged this run (it set `failed=1` above)
    )
    assert caused.failure_categories == {"server_error": 1, code: 1, "account_hold_unpublished": 1}
    assert caused.failed == 1
    state.close()


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_a_document_failure_already_in_the_total_never_suppresses_the_flush_authority_charge(
    tmp_path, code,
):
    """R51 Fable F1 / control #3, at the helper's own charge decision: the total ALREADY holds an
    independent document failure (no run charge, no authority category) when the flush is refused,
    and the caller passes no ``cause`` and no ``run_failure_counted`` (default false). The refusal
    is still this run's one charge, so ``failed`` goes from 1 to 2. A charge inferred from
    ``total.failed > 0`` would leave it at 1. This is helper-level coverage of that decision; the
    stream-level fixture below remains separate preservation coverage."""
    state = StateStore(str(tmp_path / f"flush-document-failure-{code}.sqlite"))
    held = state.hold_connection("conn", 2, "account", "2099-01-01T00:00:00+00:00", "rate_limited")
    execution = GdriveExecution("conn", 2, 1, "owner", "later", "scope", {}, progress={})
    client = _RefusingClient(code)
    total = IngestSummary("docs", failed=1, failure_categories={"incomplete_extraction": 1})

    await _flush_restriction_evidence(client, execution, state, "account", total)

    assert total.failed == 2
    assert total.failure_categories == {"incomplete_extraction": 1, code: 1, "account_hold_unpublished": 1}
    assert client.sent == 1
    assert state.connection_hold("conn", 2, "account") == held  # the local hold is retained
    state.close()


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_a_binding_brain_error_then_a_refused_flush_is_charged_once(tmp_path, monkeypatch, clock, code):
    """R51 Note A through the REAL binding catch: root A's long 503 minimum is journaled, root B's
    read ends the binding with a nonterminal BrainError (the caller charges the run once), and the
    flush that would publish A's minimum is refused with a terminal authority code. The run is ONE
    failure: the original cause stays, the authority and unpublished categories appear once each."""
    world = _two_root_world(monkeypatch)
    world.unreadable["file-a"] = real_deferral(503, LONG)
    world.unreadable["file-b"] = BrainError(503, "server_error", "brain unavailable")
    refusals: list[int] = []
    world.checkpoint_faults.append(_refuse(code, refusals))
    state = StateStore(str(tmp_path / f"binding-{code}.sqlite"))

    summary = await world.run(state)

    assert summary.failed == 1
    assert summary.failure_categories.get("server_error") == 1  # the original cause, unchanged
    assert summary.failure_categories.get(code) == 1
    assert summary.failure_categories.get("document_restriction_unpublished") == 1
    assert "coordinator_error" not in summary.failure_categories
    assert refusals == [1]
    assert "file-a" in state.document_restrictions(world.integration_id, GEN, "account")  # kept locally
    state.close()


def _refuse_then_watch(code, refusals, later, *, only=None):
    """A checkpoint fault: the first matching checkpoint is refused with ``code``; any checkpoint
    sent after that refusal is recorded in ``later`` (and let through)."""
    def fault(payload):
        if refusals:
            later.append(1)
            return None
        if only is None or payload.get(only):
            refusals.append(1)
            return BrainError(409, code, "refused")
        return None
    return fault


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_no_streams_with_unresolved_roots_and_a_refused_flush_is_one_run_failure(
    tmp_path, monkeypatch, clock, code,
):
    """R51 adjacent run count — no streams: both selected roots stay unresolved (one with a named
    503 minimum, so publication is attempted), the run is charged once for them, and the refused
    flush adds its authority and unpublished categories without a second charge."""
    world = _two_root_world(monkeypatch)
    world.unreadable["file-a"] = real_deferral(503, LONG)
    world.unreadable["file-b"] = _ProviderHttpError(404)
    refusals: list[int] = []
    later: list[int] = []
    world.checkpoint_faults.extend([_refuse_then_watch(code, refusals, later)] * 5)
    state = StateStore(str(tmp_path / f"no-streams-{code}.sqlite"))

    summary = await world.run(state)

    assert summary.failed == 1
    assert summary.failure_categories.get("selection_root_unresolved") == 2  # retained
    assert summary.failure_categories.get(code) == 1
    assert summary.failure_categories.get("document_restriction_unpublished") == 1
    assert "selection_unresolved" not in summary.failure_categories
    assert "file-a" in state.document_restrictions(world.integration_id, GEN, "account")  # kept locally
    assert refusals == [1] and later == []  # one refusal, no later checkpoint
    assert world.calls == [("metadata", "file-a"), ("metadata", "file-b")]  # no provider call after
    state.close()


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_the_selection_unresolved_arm_and_a_refused_flush_is_one_run_failure(
    tmp_path, monkeypatch, clock, code,
):
    """R51 adjacent run count — the `selection_unresolved` fallback arm (no stream and no unresolved
    root: nothing is selected), bounded by a minimum already in the local journal so the flush
    attempts publication. The arm's charge is the run's one failure."""
    world = _DriveWorld().install(monkeypatch)  # no file, folder or Shared Drive selected
    state = StateStore(str(tmp_path / f"selection-unresolved-{code}.sqlite"))
    not_before = "2099-01-01T00:00:00+00:00"
    state.restrict_document(world.integration_id, GEN, "account", "file-a", not_before, "provider_unavailable")
    refusals: list[int] = []
    later: list[int] = []
    world.checkpoint_faults.extend([_refuse_then_watch(code, refusals, later)] * 5)

    summary = await world.run(state)

    assert summary.failed == 1
    assert summary.failure_categories.get("selection_unresolved") == 1
    assert summary.failure_categories.get(code) == 1
    assert summary.failure_categories.get("document_restriction_unpublished") == 1
    assert "file-a" in state.document_restrictions(world.integration_id, GEN, "account")
    assert refusals == [1] and later == [] and world.calls == []
    state.close()


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_an_unresolved_root_beside_a_drain_whose_hold_checkpoint_is_refused_is_one_run_failure(
    tmp_path, monkeypatch, clock, code,
):
    """R51 adjacent run count — active drain: a selected root stays unresolved (charged once) while
    another stream drains; a quota answer opens the account hold and its checkpoint is refused. The
    run is still ONE failure, with the unresolved count, quota, authority and unpublished categories
    and the progress made before the quota answer."""
    world = _DriveWorld(file_ids=["file-u"], folder_ids=["folder-r"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("doc-a", drive="shared-a", parent="folder-r")
    world.put("doc-b", drive="shared-a", parent="folder-r")
    world.unreadable["file-u"] = _ProviderHttpError(404)  # never bound: unresolved every run
    state = StateStore(str(tmp_path / f"unresolved-drain-{code}.sqlite"))
    await run(world, state)
    assert "doc-a" in world.pushed  # the readable root's stream baselined

    for doc in ("doc-a", "doc-b"):  # doc-a drains first, then doc-b's read is the quota answer
        world.files[doc]["modifiedTime"] = "2026-10-01T00:00:00Z"
        world.logs["shared-a"].append({"fileId": doc, "file": dict(world.files[doc])})
    world.unreadable["doc-b"] = real_deferral(429, "3600")
    refusals: list[int] = []
    later: list[int] = []
    world.checkpoint_faults.extend([_refuse_then_watch(code, refusals, later, only="account_hold")] * 5)
    world.pushed.clear()
    world.calls.clear()
    summary = await run(world, state)

    assert summary.failed == 1
    assert summary.failure_categories.get("selection_root_unresolved") == 1  # original count
    assert summary.failure_categories.get("rate_limited") == 1
    assert summary.failure_categories.get(code) == 1
    assert summary.failure_categories.get("account_hold_unpublished") == 1
    assert "doc-a" in world.pushed and summary.created + summary.updated >= 1  # partial progress
    assert state.connection_hold(world.integration_id, GEN, "account") is not None  # local hold
    assert world.calls[-1] == ("metadata", "doc-b")  # nothing read after the quota answer
    assert refusals == [1] and later == []  # nothing sent after the refusal
    state.close()


@pytest.mark.parametrize("code", CODES)
@pytest.mark.asyncio
async def test_an_independent_document_failure_stays_counted_beside_the_one_authority_charge(
    tmp_path, monkeypatch, clock, code,
):
    """Control: a document failure is not a run charge. It stays counted, and the refused hold
    checkpoint still adds exactly one run failure — a nonzero `failed` never suppresses it."""
    world = _folder_world(monkeypatch)
    state = StateStore(str(tmp_path / f"document-failure-{code}.sqlite"))
    assert (await run(world, state)).authoritative_complete is True

    for doc in ("doc-a", "doc-b"):  # doc-a fails as a document, then doc-b's read is the quota answer
        world.files[doc]["modifiedTime"] = "2026-10-01T00:00:00Z"
        world.logs["shared-a"].append({"fileId": doc, "file": dict(world.files[doc])})
    world.malformed.add("doc-a")
    world.unreadable["doc-b"] = real_deferral(429, "3600")
    refusals: list[int] = []
    later: list[int] = []
    world.checkpoint_faults.extend([_refuse_then_watch(code, refusals, later, only="account_hold")] * 5)
    world.calls.clear()
    summary = await run(world, state)

    assert ("doc", "doc-a") in world.calls  # the document was attempted and failed on its own
    assert summary.failure_categories.get("incomplete_extraction") == 1  # the document failure
    assert summary.failed == 2  # one document failure + one run failure for the refusal
    assert summary.failure_categories.get(code) == 1
    assert summary.failure_categories.get("rate_limited") == 1
    assert summary.failure_categories.get("account_hold_unpublished") == 1
    assert refusals == [1] and later == []
    state.close()
