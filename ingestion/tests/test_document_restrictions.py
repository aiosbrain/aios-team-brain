"""A document's provider-named minimum is owned apart from its retry bookkeeping (AIO-1167 R49 F1).

Spec (Astra R48 adjudication F1; accepted-spec AC-04:230). When Google names a minimum for ONE
document (a 503 with a valid or unrepresentable Retry-After from the REAL provider-call owner):

  * the minimum is the DOCUMENT's restriction, keyed by connection, account, generation and stable
    provider id, independent of the observation's attempts and exhaustion;
  * no ordinary run, Run now / Retry (exhaustion rearm), newer observation, controlled rescan,
    reopened SQLite file or fresh state file reconstructed from acknowledged progress reads, pushes
    or completes that document before the minimum lapses — and the unrepresentable sentinel never
    lapses;
  * unrelated documents keep progressing, and a per-document 503 is never an account hold;
  * once a representable minimum has passed, the rearmed obligation completes normally, while a
    newer removal still supersedes stale upsert work;
  * a lost acknowledgment, or stale (older-generation / shorter) remote evidence, cannot erase the
    restriction or manufacture completion.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from aios_ingest.brain_client import BrainError
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.gdrive_sync import _MAX_AUTOMATIC_ATTEMPTS, run_gdrive_stream
from aios_ingest.sources.gdrive import LATEST_INSTANT, ProviderCursorInvalid, ProviderDeferred
from aios_ingest.state import StateStore
from test_account_hold_before_streams import provider_deferral
from test_gdrive_upgrade import _DriveWorld, _ProviderHttpError

GEN = 9
LONG = "99999999"           # ~3.2 years: valid, honoured exactly
SENTINEL = "9" * 30         # valid digits no timestamp can hold: fail closed


@pytest.fixture
def clock(monkeypatch):
    """One clock for the coordinator and the state store, starting at the real present."""
    now = SimpleNamespace(at=datetime.now(timezone.utc))
    monkeypatch.setattr("aios_ingest.gdrive_sync._now", lambda: now.at.isoformat())
    monkeypatch.setattr("aios_ingest.state._now_iso", lambda: now.at.isoformat())
    monkeypatch.setattr("aios_ingest.gdrive_sync._backoff_seconds", lambda *_a, **_k: 0)
    return now


async def run(world, state, *, rearm=False):
    """One run; ``rearm`` is what Run now / Retry request (``rearm_exhausted``)."""
    options = {"integration_id": world.integration_id, **({"rearm_exhausted": True} if rearm else {})}
    return await run_gdrive_stream(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive", options=options), state,
    )


def _world(monkeypatch):
    world = _DriveWorld(folder_ids=["folder-r"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("doc-a", drive="shared-a", parent="folder-r")
    world.put("doc-b", drive="shared-a", parent="folder-r")
    return world


def _reads(world, doc):
    return [call for call in world.calls if call in (("metadata", doc), ("doc", doc))]


def _restriction(state, world, doc="doc-a"):
    return state.document_restrictions(world.integration_id, GEN, "account").get(doc)


async def _restrict_after_seven_failures(world, state, clock, header):
    """Seven ordinary failures, then an eighth that is a provider-call 503 naming ``header``."""
    world.unreadable["doc-a"] = _ProviderHttpError(500)
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS - 1):
        await run(world, state)
        clock.at += timedelta(seconds=1)
    world.unreadable["doc-a"] = provider_deferral(503, header)
    eighth = await run(world, state)
    world.unreadable.pop("doc-a")  # the document is readable again: only the minimum stands
    return eighth


@pytest.mark.parametrize("header, unrepresentable", [(LONG, False), (SENTINEL, True)])
@pytest.mark.asyncio
async def test_run_now_and_retry_never_read_a_restricted_document_early(
    tmp_path, monkeypatch, clock, header, unrepresentable,
):
    world = _world(monkeypatch)
    path = str(tmp_path / "restricted.sqlite")
    state = StateStore(path)

    eighth = await _restrict_after_seven_failures(world, state, clock, header)

    assert eighth.failure_categories.get("provider_unavailable", 0) >= 1
    assert "rate_limited" not in eighth.failure_categories  # never an account hold
    assert state.connection_hold(world.integration_id, GEN, "account") is None
    held = _restriction(state, world)
    assert held is not None and held[2] is unrepresentable
    if unrepresentable:
        assert held[0] == LATEST_INSTANT.isoformat()
    else:
        deadline = datetime.fromisoformat(held[0])
        assert abs((deadline - (datetime.now(timezone.utc) + timedelta(seconds=int(LONG)))).total_seconds()) < 30
    # Published in the fenced progress.
    published = world.progress["document_restrictions"]
    assert published["generation"] == GEN and published["credential"] == "account"
    assert [item["id"] for item in published["items"]] == ["doc-a"]
    assert "doc-b" in world.pushed  # the unrelated document progressed

    # Repeated Run now / Retry: the exhaustion is rearmed, the minimum is not.
    world.calls.clear()
    world.pushed.clear()
    for _ in range(3):
        clock.at += timedelta(days=30)
        held_run = await run(world, state, rearm=True)
        assert held_run.authoritative_complete is False
        assert held_run.failure_categories.get("provider_restricted_document") == 1
    assert _reads(world, "doc-a") == [] and "doc-a" not in world.pushed
    state.close()

    # The same SQLite file reopened, and a fresh one rebuilt from acknowledged progress.
    for rebuilt in (path, str(tmp_path / "fresh.sqlite")):
        state = StateStore(rebuilt)
        world.calls.clear()
        outcome = await run(world, state, rearm=True)
        if rebuilt != path:
            # The fresh file really rebuilt the stream: the folder was enumerated again and doc-a
            # is owed in it — and still was not read.
            outcome = await run(world, state, rearm=True)
            assert ("list", "shared-a", "folder-r") in world.calls
            assert state.has_owed_work(world.namespace("shared-a"), GEN, "doc-a")
        assert _reads(world, "doc-a") == [] and "doc-a" not in world.pushed
        assert outcome.authoritative_complete is False
        assert _restriction(state, world) is not None
        state.close()


@pytest.mark.asyncio
async def test_a_new_observation_and_a_controlled_rescan_keep_the_minimum_while_others_progress(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "observe.sqlite"))
    await _restrict_after_seven_failures(world, state, clock, LONG)

    # A newer observation of doc-a (it changed), and an unrelated new document.
    world.logs["shared-a"].append({"fileId": "doc-a", "file": dict(world.files["doc-a"])})
    world.put("doc-c", drive="shared-a", parent="folder-r")
    world.logs["shared-a"].append({"fileId": "doc-c", "file": dict(world.files["doc-c"])})
    world.calls.clear()
    world.pushed.clear()
    await run(world, state, rearm=True)
    assert _reads(world, "doc-a") == [] and "doc-c" in world.pushed

    # A controlled rescan (the provider rejects the cursor) re-enumerates doc-a: still not read.
    world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
    await run(world, state)
    world.cursor_errors.clear()
    world.calls.clear()
    for _ in range(2):
        rescanned = await run(world, state, rearm=True)
    assert ("list", "shared-a", "folder-r") in world.calls  # the rescan re-enumerated the folder
    assert _reads(world, "doc-a") == [] and "doc-a" not in world.pushed
    assert rescanned.authoritative_complete is False
    state.close()


@pytest.mark.asyncio
async def test_after_a_representable_minimum_passes_the_rearmed_obligation_completes(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "lapse.sqlite"))
    await _restrict_after_seven_failures(world, state, clock, "120")

    clock.at += timedelta(seconds=60)
    world.calls.clear()
    await run(world, state, rearm=True)
    assert _reads(world, "doc-a") == []  # not yet

    clock.at += timedelta(seconds=120)
    world.pushed.clear()
    done = await run(world, state, rearm=True)
    assert "doc-a" in world.pushed
    if not done.authoritative_complete:
        done = await run(world, state)
    assert done.authoritative_complete is True
    assert "document_restrictions" not in world.progress  # a lapsed minimum is no longer published
    state.close()


@pytest.mark.asyncio
async def test_a_newer_removal_supersedes_stale_upsert_work_once_the_minimum_passes(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "supersede.sqlite"))
    await _restrict_after_seven_failures(world, state, clock, "120")

    # doc-a is deleted while restricted.
    world.files.pop("doc-a")
    world.logs["shared-a"].append({"fileId": "doc-a", "removed": True})
    clock.at += timedelta(seconds=300)
    world.pushed.clear()
    for _ in range(2):
        await run(world, state, rearm=True)
    assert "doc-a" not in world.pushed  # the stale upsert never restored content
    assert "doc-a" in world.removed
    state.close()


@pytest.mark.asyncio
async def test_a_lost_acknowledgment_keeps_the_local_restriction_and_claims_nothing(
    tmp_path, monkeypatch, clock,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "lost-ack.sqlite"))
    world.unreadable["doc-a"] = _ProviderHttpError(500)
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS - 1):
        await run(world, state)
        clock.at += timedelta(seconds=1)
    world.unreadable["doc-a"] = provider_deferral(503, LONG)
    # Every checkpoint of the run that records the minimum fails.
    world.checkpoint_faults.extend(
        [lambda _payload: BrainError(503, "unavailable", "lost")] * 10
    )
    lost = await run(world, state)
    world.checkpoint_faults.clear()
    world.unreadable.pop("doc-a")

    assert lost.authoritative_complete is False
    assert _restriction(state, world) is not None  # local evidence kept
    assert "doc-a" not in [item["id"] for item in (world.progress.get("document_restrictions") or {}).get("items", [])]

    # The next run publishes it; nothing was read early meanwhile.
    world.calls.clear()
    await run(world, state, rearm=True)
    assert _reads(world, "doc-a") == []
    assert [item["id"] for item in world.progress["document_restrictions"]["items"]] == ["doc-a"]
    state.close()


@pytest.mark.parametrize("remote", ["older-generation-shorter", "shorter-same-generation"])
@pytest.mark.asyncio
async def test_stale_remote_evidence_cannot_shorten_or_erase_a_restriction(
    tmp_path, monkeypatch, clock, remote,
):
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "stale.sqlite"))
    await _restrict_after_seven_failures(world, state, clock, LONG)
    held = _restriction(state, world)

    short = (clock.at + timedelta(seconds=5)).isoformat()
    world.progress["document_restrictions"] = {
        "generation": GEN - 1 if remote.startswith("older") else GEN,
        "credential": "account",
        "items": [{"id": "doc-a", "not_before": short, "category": "provider_unavailable", "unrepresentable": False}],
    }
    clock.at += timedelta(seconds=60)
    world.calls.clear()
    outcome = await run(world, state, rearm=True)

    assert _restriction(state, world) == held
    assert _reads(world, "doc-a") == [] and outcome.authoritative_complete is False
    assert world.progress["document_restrictions"]["items"][0]["not_before"] == held[0]
    state.close()


def test_restrictions_merge_monotonically_and_the_sentinel_never_lapses(tmp_path):
    state = StateStore(str(tmp_path / "merge.sqlite"))
    key = ("conn", GEN, "account", "doc")
    long = "2029-12-01T00:00:00+00:00"
    assert state.restrict_document(*key, long, "provider_unavailable") == (long, "provider_unavailable", False)
    assert state.restrict_document(*key, "2026-11-01T00:00:00+00:00", "provider_unavailable")[0] == long
    sentinel = LATEST_INSTANT.isoformat()
    assert state.restrict_document(*key, sentinel, "provider_unavailable", unrepresentable=True)[2] is True
    # A later valid restriction — even a "later" instant — never relabels the unrepresentable one.
    assert state.restrict_document(*key, sentinel, "provider_unavailable", unrepresentable=False)[2] is True
    assert state.restrict_document(*key, long, "provider_unavailable")[2] is True
    state.close()


@pytest.mark.asyncio
async def test_a_restricted_selected_file_root_is_not_read_by_a_controlled_rescan(tmp_path, monkeypatch, clock):
    world = _DriveWorld(file_ids=["file-x", "file-y"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("file-y", drive="shared-a")
    state = StateStore(str(tmp_path / "file-root.sqlite"))
    # file-x is owed again (it changed), then its reads fail into a provider-named minimum.
    assert (await run(world, state)).authoritative_complete is True
    world.logs["shared-a"].append({"fileId": "file-x", "file": dict(world.files["file-x"])})
    world.unreadable["file-x"] = _ProviderHttpError(500)
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS - 1):
        await run(world, state)
        clock.at += timedelta(seconds=1)
    world.unreadable["file-x"] = provider_deferral(503, LONG)
    await run(world, state)
    world.unreadable.pop("file-x")
    assert _restriction(state, world, "file-x") is not None

    # A controlled rescan rebuilds the file pages: file-x's page is not read, file-y's is.
    world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
    await run(world, state)
    world.cursor_errors.clear()
    world.calls.clear()
    outcome = await run(world, state, rearm=True)
    assert ("metadata", "file-x") not in world.calls and ("metadata", "file-y") in world.calls
    assert outcome.authoritative_complete is False
    assert outcome.failure_categories.get("provider_restricted_document") == 1
    state.close()


def test_rearm_drops_only_the_local_backoff_and_keeps_external_and_unknown_minimums(tmp_path):
    """R50 F2 (replaces R49's synthetic year-2099 retention test). Rearm owns the attempt budget AND
    the local exponential backoff; an external (provider- or brain-named) minimum recorded with the
    failure survives it; a legacy row whose combined deadline has no recorded provenance keeps it."""
    state = StateStore(str(tmp_path / "rearm.sqlite"))
    namespace = "ns"
    for doc in ("backoff-only", "named-minimum", "legacy"):
        state.enqueue_work(namespace, GEN, doc, "upsert", {"file_id": doc})
    works = {work.item_key: work for work in state.list_pending(namespace, GEN)}
    now = datetime.now(timezone.utc)
    backoff = (now + timedelta(hours=2)).isoformat()
    named = (now + timedelta(days=30)).isoformat()
    state.fail_work(works["backoff-only"], "provider_read", not_before=backoff, exhaust=True)
    state.fail_work(works["named-minimum"], "503 named a wait", not_before=named, exhaust=True, minimum=named)
    state.fail_work(works["legacy"], "written before R50", not_before=backoff, exhaust=True)
    # A row from before the provenance columns existed: its deadline's composition is unknown.
    state._db.execute(
        "UPDATE pending_work SET deadline_tracked=0, minimum_not_before=NULL WHERE item_key='legacy'",
    )
    state._db.commit()

    assert state.rearm_exhausted(namespace, GEN) == 3

    rows = {
        row["item_key"]: row for row in state._db.execute(
            "SELECT item_key, attempts, failures, exhausted_at, not_before FROM pending_work",
        ).fetchall()
    }
    assert all((r["attempts"], r["failures"], r["exhausted_at"]) == (0, 0, None) for r in rows.values())
    assert rows["backoff-only"]["not_before"] is None   # eligible at once
    assert rows["named-minimum"]["not_before"] == named  # the external minimum survives
    assert rows["legacy"]["not_before"] == backoff       # unknown provenance is never waived
    assert [work.item_key for work in state.list_pending(namespace, GEN)] == ["backoff-only"]
    state.close()


@pytest.mark.asyncio
async def test_explicit_rearm_retries_exhausted_unrestricted_work_at_once_while_polling_stays_bounded(
    tmp_path, monkeypatch,
):
    """R50 F2 with REAL nonzero exponential backoff (no clock or backoff patch): after the eighth
    ordinary failure an automatic poll neither reads nor exhausts-away the document, and an explicit
    Admin rearm (Run now / Retry) reads it immediately."""
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "real-backoff.sqlite"))
    namespace = world.namespace("shared-a")
    world.unreadable["doc-a"] = _ProviderHttpError(500)
    await run(world, state)
    for _ in range(_MAX_AUTOMATIC_ATTEMPTS - 1):
        # Only the wait between failures is skipped; each failure is the real `_fail_work` path.
        state._db.execute(
            "UPDATE pending_work SET not_before=NULL WHERE item_key='doc-a' AND exhausted_at IS NULL",
        )
        state._db.commit()
        await run(world, state)
    row = state._db.execute(
        "SELECT failures, exhausted_at, not_before, minimum_not_before, deadline_tracked FROM pending_work "
        "WHERE namespace=? AND item_key='doc-a' AND acknowledged_at IS NULL AND superseded_at IS NULL",
        (namespace,),
    ).fetchone()
    assert row["failures"] == _MAX_AUTOMATIC_ATTEMPTS and row["exhausted_at"] is not None
    assert datetime.fromisoformat(row["not_before"]) > datetime.now(timezone.utc) + timedelta(minutes=30)
    assert (row["minimum_not_before"], row["deadline_tracked"]) == (None, 1)  # backoff only
    world.unreadable.pop("doc-a")

    # Automatic polling: exhausted and inside its backoff — not read.
    world.calls.clear()
    polled = await run(world, state)
    assert _reads(world, "doc-a") == [] and polled.failure_categories.get("retry_exhausted") == 1

    # Explicit Admin rearm: the attempt budget AND the local backoff reset — read now.
    world.pushed.clear()
    await run(world, state, rearm=True)
    assert ("metadata", "doc-a") in world.calls and "doc-a" in world.pushed
    state.close()


def _skip_wait(state):
    """Skip only the wait between failures; each failure stays the real `_fail_work` path."""
    state._db.execute("UPDATE pending_work SET not_before=NULL WHERE item_key='doc-a' AND exhausted_at IS NULL")
    state._db.commit()


@pytest.mark.parametrize("eighth", ["timeout", "malformed-retry-after"])
@pytest.mark.asyncio
async def test_a_local_fallback_on_the_exhausting_failure_is_backoff_that_rearm_drops(
    tmp_path, monkeypatch, eighth,
):
    """R51 F5. The exhausting failure is a real ProviderDeferred whose `not_before` is THIS
    sidecar's own wait — a timeout's, or the bounded fallback for a malformed Retry-After — not a
    provider-named minimum. It still delays the next attempt, but it is not recorded as an external
    minimum and is no restriction, so an explicit rearm makes the (otherwise unrestricted) document
    eligible at once. Ordinary polling still does not read exhausted work."""
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / f"fallback-{eighth}.sqlite"))
    namespace = world.namespace("shared-a")
    world.unreadable["doc-a"] = _ProviderHttpError(500)
    await run(world, state)
    for attempt in range(_MAX_AUTOMATIC_ATTEMPTS - 1):
        _skip_wait(state)
        if attempt == _MAX_AUTOMATIC_ATTEMPTS - 2:
            world.unreadable["doc-a"] = (
                ProviderDeferred(
                    "read timed out", category="provider_timeout",
                    not_before=(datetime.now(timezone.utc) + timedelta(hours=3)).isoformat(),
                )
                if eighth == "timeout" else provider_deferral(503, "not-a-delay")
            )
        await run(world, state)
    row = state._db.execute(
        "SELECT failures, exhausted_at, not_before, minimum_not_before, deadline_tracked FROM pending_work "
        "WHERE namespace=? AND item_key='doc-a' AND acknowledged_at IS NULL AND superseded_at IS NULL",
        (namespace,),
    ).fetchone()
    assert row["failures"] == _MAX_AUTOMATIC_ATTEMPTS and row["exhausted_at"] is not None
    assert datetime.fromisoformat(row["not_before"]) > datetime.now(timezone.utc)  # the wait applies
    assert (row["minimum_not_before"], row["deadline_tracked"]) == (None, 1)  # but is not external
    assert _restriction(state, world) is None  # and is no restriction
    world.unreadable.pop("doc-a")

    world.calls.clear()
    await run(world, state)
    assert _reads(world, "doc-a") == []  # polling: exhausted work is not read

    world.pushed.clear()
    await run(world, state, rearm=True)
    assert ("metadata", "doc-a") in world.calls and "doc-a" in world.pushed
    state.close()


@pytest.mark.asyncio
async def test_run_now_keeps_the_backoff_of_work_that_is_not_exhausted(tmp_path, monkeypatch):
    """R51 adjudication item 5 (negative control): rearm owns EXHAUSTED work only. A document with
    one ordinary failure keeps its real local backoff through an explicit Run now."""
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "not-exhausted.sqlite"))
    world.unreadable["doc-a"] = _ProviderHttpError(500)
    await run(world, state)
    world.unreadable.pop("doc-a")

    world.calls.clear()
    await run(world, state, rearm=True)
    assert _reads(world, "doc-a") == []
    row = state._db.execute(
        "SELECT failures, exhausted_at FROM pending_work WHERE item_key='doc-a' "
        "AND acknowledged_at IS NULL AND superseded_at IS NULL",
    ).fetchone()
    assert (row["failures"], row["exhausted_at"]) == (1, None)
    state.close()


@pytest.mark.parametrize("category", ["dispatch_deadline", "run_deadline"])
@pytest.mark.asyncio
async def test_a_local_deadline_in_the_drain_keeps_its_own_category_and_charges_nothing(
    tmp_path, monkeypatch, category,
):
    """R51 F7: the drain reports the local stop it actually met — `dispatch_deadline` or
    `run_deadline` — and it is neither a provider hold, a restriction, nor a document failure."""
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / f"drain-{category}.sqlite"))
    namespace = world.namespace("shared-a")
    world.unreadable["doc-a"] = ProviderDeferred("budget spent", category=category)

    summary = await run(world, state)

    other = ({"dispatch_deadline", "run_deadline"} - {category}).pop()
    assert summary.failure_categories.get(category) == 1
    assert other not in summary.failure_categories
    assert summary.failed == 0
    assert state.connection_hold(world.integration_id, GEN, "account") is None
    assert _restriction(state, world) is None
    assert state.has_owed_work(namespace, GEN, "doc-a")  # still owed
    failures = state._db.execute(
        "SELECT failures FROM pending_work WHERE item_key='doc-a' AND acknowledged_at IS NULL "
        "AND superseded_at IS NULL",
    ).fetchone()["failures"]
    assert failures == 0
    state.close()


@pytest.mark.parametrize("category", ["dispatch_deadline", "run_deadline"])
def test_a_local_deadline_on_a_streams_start_token_keeps_its_own_category(category):
    """R51 F7 at the stream's start-token seam: the local stop is reported as itself, no restriction
    is recorded (the state is never touched) and nothing is charged."""
    from aios_ingest.engine import IngestSummary
    from aios_ingest.gdrive_sync import _stream_start_deferred

    summary = _stream_start_deferred(
        None, None, {}, "shared-a", ProviderDeferred("budget spent", category=category),
        IngestSummary("docs", failure_categories={}),
    )
    assert summary.failure_categories == {category: 1}
    assert summary.skipped == 1 and summary.failed == 0


@pytest.mark.asyncio
async def test_recovery_never_reinterprets_an_unrepresentable_restriction_as_an_expiring_instant(
    tmp_path, monkeypatch, clock,
):
    """The classification, not the stored instant, governs: acknowledged evidence that a minimum
    was unrepresentable keeps the document closed even if its instant reads as past."""
    world = _world(monkeypatch)
    state = StateStore(str(tmp_path / "first.sqlite"))
    assert (await run(world, state)).authoritative_complete is True
    state.close()
    world.logs["shared-a"].append({"fileId": "doc-a", "file": dict(world.files["doc-a"])})
    world.progress["document_restrictions"] = {
        "generation": GEN, "credential": "account",
        "items": [{"id": "doc-a", "not_before": "2000-01-01T00:00:00+00:00",
                   "category": "provider_unavailable", "unrepresentable": True}],
    }
    fresh = StateStore(str(tmp_path / "fresh.sqlite"))
    world.calls.clear()
    world.pushed.clear()
    for _ in range(2):
        await run(world, fresh, rearm=True)
    assert _reads(world, "doc-a") == [] and "doc-a" not in world.pushed
    assert _restriction(fresh, world)[2] is True
    fresh.close()
