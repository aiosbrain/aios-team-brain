"""Bounded document recovery in the Drive drain (AIO-1167 R44 C6, C7, U5).

C7 — retries. A failed document waits a capped exponential backoff with jitter computed from its
PERSISTED attempt count (never a constant), and never less than a wait the provider or brain named.
After a bounded number of automatic attempts it is EXHAUSTED: no longer retried automatically, still
owed (it keeps counting as pending, so the run stays partial and absence stays withheld), until an
explicit Admin run re-arms it or a new observation of the document resets it.

C6 — provider admission. A rate-limit deferral governs the account, not one document: the drain
stops with that provider's not-before, making no further provider call, and leaves the remaining
work — including the document that was refused — untouched.

U5 — local budget. A read the run's budget expired before dispatch is not a provider failure: the
drain stops, the obligation is untouched (no attempt counted), and nothing is reported failed.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from aios_ingest.brain_client import GdriveExecution
from aios_ingest.config import Connection
from aios_ingest.engine import IngestSummary
from aios_ingest.gdrive_sync import (
    _MAX_AUTOMATIC_ATTEMPTS,
    _RETRY_BASE_SECONDS,
    _RETRY_CAP_SECONDS,
    _ProviderAdmissionClosed,
    _backoff_seconds,
    _drain_pending,
    _fail_work,
    _retry_deferred,
)
from aios_ingest.sources.gdrive import ProviderDeferred
from aios_ingest.state import StateStore, StreamKey


def _parse(iso: str) -> datetime:
    at = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return at if at.tzinfo else at.replace(tzinfo=timezone.utc)


@pytest.fixture()
def world(tmp_path):
    state = StateStore(str(tmp_path / "drain.sqlite"))
    progress = state.begin_generation(StreamKey("team", "conn", "acct", "my-drive"), 2, start_token="start")
    yield state, progress.namespace
    state.close()


def _row(state, namespace, key="doc"):
    return state._db.execute(
        "SELECT attempts, not_before, exhausted_at FROM pending_work WHERE namespace=? AND item_key=?",
        (namespace, key),
    ).fetchone()


# --- C7 -------------------------------------------------------------------------------------------

def test_backoff_grows_from_the_persisted_attempt_count_and_is_capped():
    full = [_backoff_seconds(n, rng=lambda: 1.0) for n in range(12)]
    assert full[:3] == [_RETRY_BASE_SECONDS, 2 * _RETRY_BASE_SECONDS, 4 * _RETRY_BASE_SECONDS]
    assert full == sorted(full) and max(full) == _RETRY_CAP_SECONDS
    # Jitter keeps the delay within [50%, 100%] of the step.
    assert _backoff_seconds(3, rng=lambda: 0.0) == 4 * _RETRY_BASE_SECONDS


def test_repeated_failures_wait_longer_each_time(world, monkeypatch):
    monkeypatch.setattr("aios_ingest.gdrive_sync.random.random", lambda: 0.5)
    state, namespace = world
    state.enqueue_work(namespace, 2, "doc", "upsert", {})
    waits = []
    for _ in range(3):
        before = datetime.now(timezone.utc)
        _fail_work(state, _row_work(state, namespace), "boom")
        waits.append((_parse(_row(state, namespace)["not_before"]) - before).total_seconds())
    assert waits[0] < waits[1] < waits[2]
    assert waits[0] >= 0.5 * _RETRY_BASE_SECONDS - 1


def _row_work(state, namespace):
    """The obligation as the drain would hold it, regardless of its not-before (for direct tests)."""
    row = state._db.execute("SELECT * FROM pending_work WHERE namespace=? AND item_key='doc'", (namespace,)).fetchone()
    from aios_ingest.state import PendingWork
    import json
    return PendingWork(row["namespace"], row["generation"], row["item_key"], row["action"],
                       row["observation_revision"], json.loads(row["payload"]), row["attempts"],
                       row["not_before"], row["last_error"], row["page_id"], row["acknowledged_at"])


def test_a_named_wait_longer_than_the_backoff_wins_and_a_shorter_one_does_not_shorten_it(world):
    state, namespace = world
    state.enqueue_work(namespace, 2, "doc", "upsert", {})
    far = (datetime.now(timezone.utc) + timedelta(hours=10)).isoformat()
    _fail_work(state, _row_work(state, namespace), "429", retry_after=far)
    assert _parse(_row(state, namespace)["not_before"]) == _parse(far)
    near = (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()
    _fail_work(state, _row_work(state, namespace), "429", retry_after=near)
    assert _parse(_row(state, namespace)["not_before"]) > _parse(near) + timedelta(seconds=30)


def test_exhausted_work_stops_retrying_but_stays_owed_until_rearmed_or_reobserved(world):
    state, namespace = world
    state.enqueue_work(namespace, 2, "doc", "upsert", {})
    state.enqueue_work(namespace, 2, "other", "upsert", {})
    exhausted = False
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS):
        exhausted = _fail_work(state, _row_work(state, namespace), "permanently broken")
    assert exhausted and _row(state, namespace)["exhausted_at"] is not None
    # Not offered automatically, even once its wait has passed …
    state._db.execute("UPDATE pending_work SET not_before=NULL WHERE item_key='doc'")
    assert [w.item_key for w in state.list_pending(namespace, 2)] == ["other"]
    # … but still owed: completeness counts it, and it is reported.
    assert state.pending_count(namespace, 2) == 2
    assert state.exhausted_count(namespace, 2) == 1
    # An explicit Admin run re-arms it from attempt zero.
    assert state.rearm_exhausted(namespace, 2) == 1
    row = _row(state, namespace)
    assert (row["attempts"], row["exhausted_at"]) == (0, None)
    assert {w.item_key for w in state.list_pending(namespace, 2)} == {"doc", "other"}
    # A new observation of the document resets it as well.
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS):
        _fail_work(state, _row_work(state, namespace), "broken again")
    state.enqueue_work(namespace, 2, "doc", "upsert", {"modified": "later"})
    assert _row(state, namespace)["exhausted_at"] is None


# --- C6 / U5: the drain itself --------------------------------------------------------------------

class _Source:
    def __init__(self, raw_doc_error=None, metadata_error=None):
        self.raw_doc_error, self.metadata_error, self.calls = raw_doc_error, metadata_error, []

    def _metadata(self, file_id):
        self.calls.append(("metadata", file_id))
        if self.metadata_error:
            raise self.metadata_error
        return {"id": file_id, "mimeType": "application/vnd.google-apps.document"}

    def _raw_doc(self, meta):
        self.calls.append(("docs", meta["id"]))
        raise self.raw_doc_error


EXECUTION = GdriveExecution("conn", 2, 1, "owner", "later", "scope", {})
CONN = Connection("docs", "gdrive", options={})


async def _drain(state, namespace, source, summary):
    return await _drain_pending(None, EXECUTION, source, CONN, state, namespace, 2, summary, 10)


@pytest.mark.asyncio
async def test_a_long_rate_limit_stops_the_drain_and_touches_no_work(world):
    state, namespace = world
    for key in [f"doc-{n}" for n in range(10)]:
        state.enqueue_work(namespace, 2, key, "upsert", {})
    later = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    source = _Source(metadata_error=ProviderDeferred("429", not_before=later, category="rate_limited"))
    summary = IngestSummary("docs", failure_categories={})

    with pytest.raises(_ProviderAdmissionClosed) as closed:
        await _drain(state, namespace, source, summary)

    assert closed.value.not_before == later
    assert len(source.calls) == 1  # no further provider call for the account
    assert summary.failed == 0
    rows = state._db.execute("SELECT attempts, not_before FROM pending_work WHERE namespace=?", (namespace,)).fetchall()
    assert all(row["attempts"] == 0 and row["not_before"] is None for row in rows)


def test_the_persisted_hold_blocks_early_calls_and_lifts_after_the_deadline(world):
    state, namespace = world
    later = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
    state.update_progress(namespace, retry_not_before=later, last_error="rate_limited")
    reopened = state.get_progress(namespace)
    assert _retry_deferred(reopened.retry_not_before) is True
    assert _retry_deferred(reopened.retry_not_before, now=(datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()) is False


@pytest.mark.asyncio
async def test_budget_expiry_between_metadata_and_docs_is_local_and_untouched(world):
    state, namespace = world
    state.enqueue_work(namespace, 2, "doc", "upsert", {})
    state.enqueue_work(namespace, 2, "doc-2", "upsert", {})
    source = _Source(raw_doc_error=ProviderDeferred("budget", category="dispatch_deadline"))
    summary = IngestSummary("docs", failure_categories={})

    await _drain(state, namespace, source, summary)

    assert source.calls == [("metadata", "doc"), ("docs", "doc")]  # no further provider call
    assert summary.failed == 0 and summary.failure_categories == {"run_deadline": 1}
    assert _row(state, namespace)["attempts"] == 0 and _row(state, namespace)["not_before"] is None
    assert state.pending_count(namespace, 2) == 2


@pytest.mark.asyncio
async def test_a_sent_request_that_times_out_is_still_a_counted_failure(world):
    state, namespace = world
    state.enqueue_work(namespace, 2, "doc", "upsert", {})
    source = _Source(raw_doc_error=ProviderDeferred("late", category="provider_timeout"))
    summary = IngestSummary("docs", failure_categories={})
    await _drain(state, namespace, source, summary)
    assert summary.failed == 1 and summary.failure_categories == {"provider_timeout": 1}
    assert _row(state, namespace)["attempts"] == 1
