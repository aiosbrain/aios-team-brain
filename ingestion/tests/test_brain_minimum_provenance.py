"""Only a minimum the BRAIN named is an external minimum (AIO-1167 R51 L2).

Spec (Astra R51 Low adjudication, L2). ``BrainDeferred.not_before`` is the combined local eligibility
— the brain's Retry-After when it named one, else the client's own exponential fallback, plus
jitter. ``BrainDeferred.provider_not_before`` is ONLY the brain-named minimum: absent without a
header or with a malformed one or for an unanswered request, present for a valid positive or ZERO
Retry-After. Consumers persist only the brain-named part as ``pending_work.minimum_not_before``:

  * an exhausting sink failure deferred on local fallback leaves no external minimum, and an
    explicit rearm makes the work eligible at once;
  * a valid positive Retry-After stays a minimum through rearm; a valid zero is recorded (not
    confused with no header) and is already elapsed; an earlier minimum is never erased;
  * non-exhausted work keeps its ordinary backoff;
  * an accepted document whose checkpoint is deferred keeps its obligation, spends no failure
    budget, records only a brain-named minimum, and still honours the uncertainty latch.
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from aios_ingest.brain_client import BrainClient, BrainDeferred, BrainError, GdriveExecution, IngestResult
from aios_ingest.config import Connection
from aios_ingest.engine import IngestSummary
from aios_ingest.gdrive_sync import (
    _MAX_AUTOMATIC_ATTEMPTS, _AcknowledgmentUncertain, _drain_pending, _fail_work, _record_sink_failure,
)
from aios_ingest.state import StateStore, StreamKey
from test_drain_recovery import _PushedSource, _row_work

ERROR = {"error": {"code": "unavailable", "message": "brain unavailable"}}


def _at(iso: str) -> datetime:
    parsed = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _client(clock: dict) -> BrainClient:
    async def sleep(delay):
        clock["t"] += delay

    return BrainClient(
        "http://brain", "aios_a_b", "team", sleep=sleep, random_fn=lambda: 0.0, monotonic_fn=lambda: clock["t"],
    )


async def _push_deferral(header: str | None) -> BrainDeferred:
    """The REAL client's deferral for one retryable answer whose wait does not fit the deadline."""
    async with _client({"t": 0.0}) as client:
        headers = {} if header is None else {"Retry-After": header}
        with pytest.raises(BrainDeferred) as raised:
            await client._backoff(httpx.Response(503, headers=headers, json=ERROR), 7, 0.5)
    return raised.value


async def _timeout_deferral() -> BrainDeferred:
    async with _client({"t": 0.0}) as client:
        with pytest.raises(BrainDeferred) as raised:
            await client._timeout_backoff(BrainError(504, "brain_timeout", "unanswered"), 7, 0.5)
    return raised.value


@pytest.mark.parametrize("header, named", [
    (None, False), ("soon", False), ("30", True), ("0", True),
], ids=["no-header", "malformed", "positive", "zero"])
@pytest.mark.asyncio
async def test_a_brain_deferral_carries_only_the_brain_named_minimum(header, named):
    deferral = await _push_deferral(header)
    now = datetime.now(timezone.utc)
    assert deferral.not_before is not None  # the combined local eligibility is always there
    if not named:
        assert deferral.provider_not_before is None
        return
    assert deferral.provider_not_before is not None  # a valid zero is NOT "no header"
    minimum = _at(deferral.provider_not_before)
    if header == "0":
        assert minimum <= now + timedelta(seconds=1)
    else:
        assert now + timedelta(seconds=25) < minimum < now + timedelta(seconds=35)
    assert _at(deferral.not_before) >= minimum


@pytest.mark.asyncio
async def test_an_unanswered_request_fallback_names_no_minimum():
    deferral = await _timeout_deferral()
    assert deferral.not_before is not None and deferral.provider_not_before is None


@pytest.mark.parametrize("header, named", [(None, False), ("30", True)], ids=["no-header", "positive"])
@pytest.mark.asyncio
async def test_a_deferred_checkpoint_carries_only_the_brain_named_minimum_and_latches(header, named):
    clock = {"t": 0.0}
    execution = dataclasses.replace(GdriveExecution("conn", 2, 1, "owner", "later", "scope", {}), run_deadline=0.5)

    def handler(_request):
        return httpx.Response(503, headers={} if header is None else {"Retry-After": header}, json=ERROR)

    async with _client(clock) as client:
        await client._client.aclose()
        client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with pytest.raises(BrainDeferred) as raised:
            await client.checkpoint_gdrive_execution(execution, {"streams": {}})
        assert client.gdrive_progress_uncertain(execution) is True  # the latch is unchanged
    assert raised.value.not_before is not None
    assert (raised.value.provider_not_before is not None) is named


@pytest.fixture()
def world(tmp_path):
    state = StateStore(str(tmp_path / "provenance.sqlite"))
    progress = state.begin_generation(StreamKey("team", "conn", "acct", "my-drive"), 2, start_token="start")
    yield state, progress.namespace
    state.close()


def _row(state, namespace):
    return state._db.execute(
        "SELECT failures, exhausted_at, not_before, minimum_not_before FROM pending_work "
        "WHERE namespace=? AND item_key='doc' AND acknowledged_at IS NULL AND superseded_at IS NULL",
        (namespace,),
    ).fetchone()


def _eligible(state, namespace) -> bool:
    return [work.item_key for work in state.list_pending(namespace, 2)] == ["doc"]


async def _exhaust_on(state, namespace, deferral: BrainDeferred) -> None:
    """Seven ordinary failures, then an eighth that is the sink's deferral."""
    state.enqueue_work(namespace, 2, "doc", "upsert", {})
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS - 1):
        _fail_work(state, _row_work(state, namespace), "provider_read")
    _record_sink_failure(state, _row_work(state, namespace), deferral, IngestSummary("docs", failure_categories={}))


@pytest.mark.parametrize("source", ["no-header", "malformed", "timeout"])
@pytest.mark.asyncio
async def test_an_exhausting_sink_failure_on_local_fallback_leaves_no_minimum_and_rearm_reads_at_once(
    world, source,
):
    state, namespace = world
    deferral = await (_timeout_deferral() if source == "timeout" else _push_deferral(None if source == "no-header" else "soon"))
    await _exhaust_on(state, namespace, deferral)

    row = _row(state, namespace)
    assert row["exhausted_at"] is not None and row["failures"] == _MAX_AUTOMATIC_ATTEMPTS
    assert row["minimum_not_before"] is None  # the client's fallback is not an external minimum
    assert state.rearm_exhausted(namespace, 2) == 1
    assert _eligible(state, namespace)


@pytest.mark.asyncio
async def test_a_valid_positive_brain_minimum_survives_rearm(world):
    state, namespace = world
    deferral = await _push_deferral("30")
    await _exhaust_on(state, namespace, deferral)

    assert _at(_row(state, namespace)["minimum_not_before"]) == _at(deferral.provider_not_before)
    state.rearm_exhausted(namespace, 2)
    assert not _eligible(state, namespace)


@pytest.mark.asyncio
async def test_a_valid_zero_brain_minimum_is_recorded_and_already_elapsed(world):
    state, namespace = world
    await _exhaust_on(state, namespace, await _push_deferral("0"))

    assert _row(state, namespace)["minimum_not_before"] is not None  # distinguishable from no header
    state.rearm_exhausted(namespace, 2)
    assert _eligible(state, namespace)


@pytest.mark.asyncio
async def test_an_earlier_brain_minimum_is_never_erased_by_a_later_local_fallback(world):
    state, namespace = world
    named = await _push_deferral("30")
    state.enqueue_work(namespace, 2, "doc", "upsert", {})
    _record_sink_failure(state, _row_work(state, namespace), named, IngestSummary("docs", failure_categories={}))
    fallback = await _push_deferral(None)
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS - 1):
        _record_sink_failure(state, _row_work(state, namespace), fallback, IngestSummary("docs", failure_categories={}))

    row = _row(state, namespace)
    assert row["exhausted_at"] is not None
    assert _at(row["minimum_not_before"]) == _at(named.provider_not_before)
    state.rearm_exhausted(namespace, 2)
    assert not _eligible(state, namespace)


@pytest.mark.asyncio
async def test_non_exhausted_work_keeps_its_ordinary_backoff(world):
    state, namespace = world
    state.enqueue_work(namespace, 2, "doc", "upsert", {})
    _record_sink_failure(
        state, _row_work(state, namespace), await _push_deferral(None), IngestSummary("docs", failure_categories={}),
    )
    assert state.rearm_exhausted(namespace, 2) == 0
    assert _row(state, namespace)["minimum_not_before"] is None
    assert not _eligible(state, namespace)  # still inside its backoff


class _CheckpointDeferringBrain:
    """Accepts the document; its checkpoint is deferred with ``deferral``."""

    def __init__(self, deferral: BrainDeferred, *, uncertain: bool = False):
        self.deferral, self.uncertain, self.pushes = deferral, uncertain, []

    async def push(self, item, *, execution=None):
        self.pushes.append(item.path)
        return IngestResult(status="created", id="item-1", path=item.path)

    async def checkpoint_gdrive_execution(self, execution, payload):
        raise self.deferral

    def gdrive_progress_uncertain(self, execution):
        return self.uncertain


@pytest.mark.parametrize("named", [False, True], ids=["local-only", "brain-named"])
@pytest.mark.parametrize("uncertain", [False, True], ids=["acknowledged-refusal", "latched"])
@pytest.mark.asyncio
async def test_an_accepted_documents_deferred_checkpoint_records_only_a_brain_named_minimum(
    world, named, uncertain,
):
    state, namespace = world
    state.enqueue_work(namespace, 2, "doc", "upsert", {})
    later = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
    minimum = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat() if named else None
    brain = _CheckpointDeferringBrain(
        BrainDeferred(503, "server_error", "deferred", not_before=later, provider_not_before=minimum),
        uncertain=uncertain,
    )
    summary = IngestSummary("docs", failure_categories={})
    execution = GdriveExecution("conn", 2, 1, "owner", "later", "scope", {})
    conn = Connection("docs", "gdrive", options={}, project="docs")

    if uncertain:
        with pytest.raises(_AcknowledgmentUncertain):  # the latch still stops the run
            await _drain_pending(brain, execution, _PushedSource(), conn, state, namespace, 2, summary, 10)
    else:
        await _drain_pending(brain, execution, _PushedSource(), conn, state, namespace, 2, summary, 10)

    row = _row(state, namespace)
    assert brain.pushes and row is not None  # accepted, and its acknowledgment is still owed
    assert row["failures"] == 0 and row["exhausted_at"] is None  # no failure budget spent
    assert _at(row["not_before"]) >= _at(later)
    if named:
        assert _at(row["minimum_not_before"]) == _at(minimum)
    else:
        assert row["minimum_not_before"] is None
    assert state.pending_count(namespace, 2) == 1
