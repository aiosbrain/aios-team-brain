"""Exhaustion is not completion evidence (AIO-1167 R47 — F4 preserved).

Spec (accepted-spec 166/232/314; adjudication F4). A document whose automatic retries ran out is
still OWED: its content outcome was never delivered. Through the real coordinator:

  * the run stays partial, with an accurate ``retry_exhausted`` backlog diagnostic;
  * no complete-snapshot reconciliation is submitted — absence is never inferred around it, so
    nothing the brain holds is purged — however many runs pass;
  * once the document is readable again and an Admin re-arms it (Run now / Retry), the connection
    converges: the document is delivered and the complete snapshot is reconciled.

This pins the conservative gate F4 requires to stay; it is not a change of behaviour.
"""

from __future__ import annotations

import pytest

from aios_ingest.gdrive_sync import _MAX_AUTOMATIC_ATTEMPTS, run_gdrive_stream
from aios_ingest.state import StateStore
from test_checkpoint_acknowledgment import CONNECTION, DOCS, SETTINGS, world


def _complete_snapshots(w) -> list[dict]:
    return [call for call in w.reconciles if "complete_snapshot_ids" in call]


@pytest.mark.asyncio
async def test_an_exhausted_document_keeps_the_run_partial_and_never_reconciles_absence(tmp_path, monkeypatch):
    w = world(monkeypatch)
    w.unreadable = {"b1"}
    monkeypatch.setattr("aios_ingest.gdrive_sync._backoff_seconds", lambda *_args, **_kwargs: 0)
    path = str(tmp_path / "exhaust.sqlite")

    last = None
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS + 2):
        state = StateStore(path)
        last = await run_gdrive_stream(SETTINGS, CONNECTION, state)
        state.close()

    assert last.failure_categories.get("retry_exhausted") == 1
    assert last.authoritative_complete is False
    assert last.backlog is not None and last.backlog >= 1
    assert _complete_snapshots(w) == []  # no absence was ever submitted around the owed document
    state = StateStore(path)
    owed = state._db.execute(
        "SELECT item_key, exhausted_at FROM pending_work WHERE acknowledged_at IS NULL AND superseded_at IS NULL",
    ).fetchall()
    assert [(row[0], row[1] is not None) for row in owed] == [("b1", True)]
    state.close()

    # Repaired, and re-armed by an explicit Admin run: the connection converges.
    w.unreadable = set()
    state = StateStore(path)
    monkeypatch.setitem(CONNECTION.options, "rearm_exhausted", True)
    repaired = await run_gdrive_stream(SETTINGS, CONNECTION, state)
    monkeypatch.delitem(CONNECTION.options, "rearm_exhausted")
    assert "retry_exhausted" not in repaired.failure_categories
    assert repaired.authoritative_complete is True
    [snapshot] = _complete_snapshots(w)
    assert sorted(snapshot["complete_snapshot_ids"]) == sorted(doc for docs in DOCS.values() for doc in docs)
    state.close()
