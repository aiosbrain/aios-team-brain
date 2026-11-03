from aios_ingest.config import BrainSettings, Connection
from aios_ingest.scheduler import (
    build_scheduler, due_for_renewal, _renewal_job, _gdrive_outcome_status,
    _manual_gdrive_job, _poll_job, _remote_gdrive_poll_job, _gdrive_hint_job,
)
from aios_ingest.engine import IngestSummary
from aios_ingest.normalize import RawDoc
from aios_ingest.state import Channel, StateStore, StreamKey
from aios_ingest.brain_client import BrainError, GdriveExecution, GdriveRunRequest, IngestResult
import json
from datetime import datetime, timedelta, timezone
import pytest

SETTINGS = BrainSettings(base_url="http://brain", api_key="aios_a_b", team="demo")
NOW = "2026-06-14T12:00:00+00:00"


def test_gdrive_run_status_requires_authoritative_coordinator_completion():
    assert _gdrive_outcome_status(IngestSummary("g", skipped=1, deferred=True)) == "deferred"
    assert _gdrive_outcome_status(IngestSummary("g", backlog=0)) == "partial"
    assert _gdrive_outcome_status(IngestSummary("g", unchanged=3, backlog=2)) == "partial"
    assert _gdrive_outcome_status(IngestSummary(
        "g", backlog=0, authoritative_complete=True,
    )) == "complete"


def test_gdrive_run_status_reports_a_run_that_only_failed_as_failed():
    # A raised run (the sanitized exception summary) and a refused authority did no document work
    # and measured no backlog: they are failures, not progress.
    assert _gdrive_outcome_status(IngestSummary(
        "g", failed=1, failure_categories={"coordinator_error": 1},
    )) == "failed"
    assert _gdrive_outcome_status(IngestSummary(
        "g", skipped=1, failed=1, failure_categories={"reconnect_required": 1},
    )) == "failed"


@pytest.mark.parametrize("summary", [
    # Real progress beside failures stays partial: some documents succeeded.
    IngestSummary("g", created=2, updated=1, failed=1),
    IngestSummary("g", unchanged=4, failed=2),
    IngestSummary("g", removed=1, failed=1),
    # A skipped-only stop (e.g. the pre-drain run deadline) — never every skipped-only run as failed.
    IngestSummary("g", skipped=3, failure_categories={"run_deadline": 1}),
    IngestSummary("g", skipped=5, backlog=5),
    # Failed work with a MEASURED backlog is resumable coordinator state, not an outright failure.
    IngestSummary("g", failed=1, backlog=1, failure_categories={"cleanup_unavailable": 1}),
    # A page-loop/drain-loop run-deadline stop adds no `skipped`: its measured backlog carries the work.
    IngestSummary("g", skipped=0, backlog=3, failure_categories={"run_deadline": 1}),
    # A discovery/work budget exhausted: no failure category, nothing skipped, backlog outstanding.
    IngestSummary("g", backlog=4, failure_categories={}),
])
def test_gdrive_run_status_keeps_genuine_and_resumable_progress_partial(summary):
    assert _gdrive_outcome_status(summary) == "partial"


def test_gdrive_run_status_precedence_for_deferral_and_authoritative_empty_completion():
    # A busy deferral is deferred even though it skipped (and whatever else it carries).
    assert _gdrive_outcome_status(IngestSummary(
        "g", skipped=1, deferred=True, failure_categories={"execution_busy": 1},
    )) == "deferred"
    # A valid EMPTY authoritative completion (an empty selection, drained) is complete.
    assert _gdrive_outcome_status(IngestSummary("g", backlog=0, authoritative_complete=True)) == "complete"
    assert _gdrive_outcome_status(IngestSummary("g", authoritative_complete=True)) == "complete"


def test_due_for_renewal_selects_expiring_and_past():
    chans = [
        Channel("c-soon", "ch1", None, "2026-06-14T12:05:00+00:00"),   # 5m out -> due (skew 600)
        Channel("c-past", "ch2", None, "2026-06-14T11:00:00+00:00"),   # already expired -> due
        Channel("c-far", "ch3", None, "2026-06-21T12:00:00+00:00"),    # a week out -> not due
        Channel("c-none", "ch4", None, None),                          # no expiry -> skip
    ]
    due = {c.connection for c in due_for_renewal(chans, NOW, skew=600)}
    assert due == {"c-soon", "c-past"}


def test_build_scheduler_registers_one_job_per_connection(tmp_path):
    state = StateStore(str(tmp_path / "s.sqlite"))
    conns = [
        Connection(name="gh", source="github", options={"repo": "o/r"}),
        Connection(name="nt", source="notion", options={"token": "t", "page_ids": ["p"]}),
    ]
    sched = build_scheduler(SETTINGS, conns, state=state, poll_interval=60)
    ids = {j.id for j in sched.get_jobs()}
    assert ids == {"poll:gh", "poll:nt"}  # no renewal job without a WatchManager
    state.close()


def test_build_scheduler_adds_renewal_when_watch_manager_present(tmp_path):
    state = StateStore(str(tmp_path / "s.sqlite"))
    conns = [Connection(name="gd", source="gdrive", options={"folder_id": "f"})]

    class FakeWatch:
        def renew(self, channel, page_token=None):  # pragma: no cover - not invoked here
            return channel

    sched = build_scheduler(SETTINGS, conns, state=state, watch_manager=FakeWatch())
    ids = {j.id for j in sched.get_jobs()}
    assert ids == {"poll:gd", "gdrive-manual-queue", "gdrive-notification-hints", "renewal-sweep"}
    state.close()


def test_build_scheduler_bootstraps_remote_gdrive_without_a_local_connection(tmp_path):
    state = StateStore(str(tmp_path / "s.sqlite"))
    assert build_scheduler(SETTINGS, [], state=state).get_jobs() == []
    sched = build_scheduler(SETTINGS, [], state=state, bootstrap_remote_gdrive=True)
    assert {j.id for j in sched.get_jobs()} == {
        "gdrive-manual-queue", "gdrive-notification-hints", "gdrive-remote-poll",
    }
    state.close()


def test_notification_hints_are_swept_far_more_often_than_the_poll(tmp_path):
    state = StateStore(str(tmp_path / "s.sqlite"))
    sched = build_scheduler(SETTINGS, [], state=state, poll_interval=300, bootstrap_remote_gdrive=True)
    jobs = {j.id: j for j in sched.get_jobs()}
    hint = jobs["gdrive-notification-hints"].trigger.interval.total_seconds()
    poll = jobs["gdrive-remote-poll"].trigger.interval.total_seconds()
    assert hint <= 15 and poll == 300
    # One sweep at a time, and a missed tick is coalesced rather than queued.
    assert jobs["gdrive-notification-hints"].max_instances == 1
    assert jobs["gdrive-notification-hints"].coalesce is True
    state.close()


def _hint_world(monkeypatch, rows, *, fail_selections=False):
    ran, reported = [], []

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def fetch_integration_selections(self, **kwargs):
            assert kwargs == {"include_disabled": True}
            if fail_selections:
                raise BrainError(503, "unavailable", "selection read failed")
            return rows
        async def report_scheduled_gdrive_run(self, report_id, integration_id, started, summary, **kwargs):
            reported.append((integration_id, kwargs["status"]))

    async def run(_settings, conn, _state):
        ran.append(conn)
        return IngestSummary(conn.name, backlog=0, authoritative_complete=True,
                             integration_id=conn.options.get("integration_id"))

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.scheduler.run_gdrive_stream", run)
    return ran, reported


async def test_a_validated_notification_wakes_the_coordinator_without_waiting_for_the_poll(
    tmp_path, monkeypatch,
):
    """Webhook → hint → the next hint sweep runs the ordinary coordinator for that connection."""
    from aios_ingest.state import verification_hash
    from aios_ingest.webhook_app import _gdrive_notification

    path = tmp_path / "hint-wake.sqlite"
    monkeypatch.setenv("AIOS_INGEST_STATE", str(path))
    integration_id = "00000000-0000-0000-0000-00000000000a"
    key = StreamKey(SETTINGS.team, integration_id, "subject:google-123", "my-drive")
    state = StateStore(str(path))
    progress = state.begin_generation(key, 3, start_token="start")
    state.save_channel(Channel(
        "admin-docs", "chan-1", "res-1", "2099-01-01T00:00:00Z", progress.namespace,
        verification_hash("secret"),
    ))
    ran, reported = _hint_world(monkeypatch, [_oauth_row(integration_id, "admin-docs")])
    attempted: dict[str, int] = {}

    # Nothing pending: the sweep reads nothing and runs nothing.
    await _gdrive_hint_job(SETTINGS, [], state, attempted)
    assert ran == []

    # A burst of validated notifications is one triggered run, through the same coordinator path
    # (and the same run report) as a scheduled poll.
    for number in range(5):
        assert _gdrive_notification({
            "x-goog-channel-id": "chan-1", "x-goog-resource-id": "res-1",
            "x-goog-channel-token": "secret", "x-goog-message-number": str(number),
        }).status_code == 202
    await _gdrive_hint_job(SETTINGS, [], state, attempted)
    assert [conn.options["integration_id"] for conn in ran] == [integration_id]
    assert reported == [(integration_id, "complete")]

    # Coalesced: a sweep with no NEW notification does not run it again, even though the fake run
    # acknowledged nothing — the regular poll remains the repair path for that.
    await _gdrive_hint_job(SETTINGS, [], state, attempted)
    assert len(ran) == 1

    # A later notification wakes it once more.
    _gdrive_notification({
        "x-goog-channel-id": "chan-1", "x-goog-resource-id": "res-1",
        "x-goog-channel-token": "secret", "x-goog-message-number": "9",
    })
    await _gdrive_hint_job(SETTINGS, [], state, attempted)
    assert len(ran) == 2

    # An invalid notification records no hint and wakes nothing.
    assert _gdrive_notification({
        "x-goog-channel-id": "chan-1", "x-goog-resource-id": "res-1",
        "x-goog-channel-token": "wrong", "x-goog-message-number": "10",
    }).status_code == 401
    await _gdrive_hint_job(SETTINGS, [], state, attempted)
    assert len(ran) == 2
    state.close()


async def test_an_acknowledged_hint_is_not_pending(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "hint-acked.sqlite"))
    integration_id = "00000000-0000-0000-0000-00000000000a"
    key = StreamKey(SETTINGS.team, integration_id, "subject:google-123", "my-drive")
    observed = state.record_stream_hint(key)
    state.ack_stream_hint(key, observed)
    ran, _ = _hint_world(monkeypatch, [_oauth_row(integration_id, "admin-docs")])
    await _gdrive_hint_job(SETTINGS, [], state, {})
    assert ran == []
    state.close()


async def test_hint_sweep_honors_admin_state_and_keeps_local_connections(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "hint-admin.sqlite"))
    enabled = "00000000-0000-0000-0000-00000000000a"
    paused = "00000000-0000-0000-0000-00000000000b"
    unknown = "00000000-0000-0000-0000-00000000000c"
    local_id = "00000000-0000-0000-0000-00000000000d"
    for cid in (enabled, paused, unknown, local_id):
        state.record_stream_hint(StreamKey(SETTINGS.team, cid, "account", "my-drive"))
    # Another team's hint in the same state file is never this sweep's.
    state.record_stream_hint(StreamKey("other-team", enabled, "account", "my-drive"))
    local = Connection("local-docs", "gdrive", options={"service_account_key_path": "local.json"})
    ran, _ = _hint_world(monkeypatch, [
        _oauth_row(enabled, "admin-docs"),
        _oauth_row(paused, "paused-docs", status="disabled"),
        _oauth_row(local_id, "local-docs"),
    ])
    await _gdrive_hint_job(SETTINGS, [local], state, {})
    # Paused and unknown connections are not woken; a locally configured name runs as itself —
    # a legacy name-only entry is bound once to the row's immutable id (AIO-1167 R44 C11), its own
    # local options otherwise unchanged.
    assert [conn.name for conn in ran] == ["admin-docs", "local-docs"]
    assert ran[1].options == {**local.options, "integration_id": local_id}
    assert "integration_id" not in local.options  # the configured entry itself is not mutated
    state.close()


async def test_hint_sweep_fails_closed_when_admin_state_is_unreadable(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "hint-unreadable.sqlite"))
    state.record_stream_hint(StreamKey(SETTINGS.team, "00000000-0000-0000-0000-00000000000a", "a", "my-drive"))
    ran, _ = _hint_world(monkeypatch, [], fail_selections=True)
    with pytest.raises(BrainError):
        await _gdrive_hint_job(SETTINGS, [], state, {})
    assert ran == []
    state.close()


async def test_hint_sweep_is_bounded_per_tick_and_reaches_the_rest_next_tick(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "hint-bounded.sqlite"))
    ids = [f"00000000-0000-0000-0000-00000000001{index}" for index in range(6)]
    for cid in ids:
        state.record_stream_hint(StreamKey(SETTINGS.team, cid, "account", "my-drive"))
    ran, _ = _hint_world(monkeypatch, [_oauth_row(cid, f"docs-{index}") for index, cid in enumerate(ids)])
    attempted: dict[str, int] = {}
    await _gdrive_hint_job(SETTINGS, [], state, attempted, limit=4)
    assert [conn.options["integration_id"] for conn in ran] == ids[:4]
    await _gdrive_hint_job(SETTINGS, [], state, attempted, limit=4)
    assert [conn.options["integration_id"] for conn in ran] == ids
    state.close()


async def test_one_failing_hint_run_does_not_starve_the_next(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "hint-failure.sqlite"))
    first, second = "00000000-0000-0000-0000-00000000000a", "00000000-0000-0000-0000-00000000000b"
    for cid in (first, second):
        state.record_stream_hint(StreamKey(SETTINGS.team, cid, "account", "my-drive"))
    ran, _ = _hint_world(monkeypatch, [_oauth_row(first, "first"), _oauth_row(second, "second")])

    async def run(_settings, conn, _state):
        ran.append(conn)
        if conn.name == "first":
            # e.g. the brain refused the lease because a scheduled poll holds it.
            raise BrainError(409, "execution_busy", "another coordinator holds the lease")
        return IngestSummary(conn.name, backlog=0, authoritative_complete=True,
                             integration_id=conn.options.get("integration_id"))

    monkeypatch.setattr("aios_ingest.scheduler.run_gdrive_stream", run)
    await _gdrive_hint_job(SETTINGS, [], state, {})
    assert [conn.name for conn in ran] == ["first", "second"]
    # The refused stream's hint is still pending for the poll (or the next notification) to drain.
    assert state.pending_stream_hint(StreamKey(SETTINGS.team, first, "account", "my-drive")) == 1
    state.close()


_PREVIOUS_CURSOR = "2026-01-01T00:00:00+00:00"


def _generic_poll_world(monkeypatch, total, *, failing=None):
    """A replaying generic source of ``total`` documents and a sink that fails ``failing`` once."""
    fetched, pushed = [], []

    class Source:
        def fetch(self, since=None):
            fetched.append(since)
            for index in range(1, total + 1):
                yield RawDoc(source="github", external_id=f"o/r/doc-{index}.md", body=str(index))

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def push(self, item, *, execution=None):
            pushed.append(item.path)
            if item.path == failing:
                raise BrainError(503, "sink_unavailable", "retry")
            return IngestResult("created", "item", item.path)

    monkeypatch.setattr("aios_ingest.engine.build_source", lambda *_args: Source())
    monkeypatch.setattr("aios_ingest.engine.BrainClient", Client)
    return fetched, pushed


async def test_generic_poll_past_five_thousand_documents_completes_and_advances_its_cursor(
    tmp_path, monkeypatch,
):
    state = StateStore(str(tmp_path / "generic-cursor.sqlite"))
    conn = Connection(name="nt", source="notion", options={"token": "t", "page_ids": ["p"]})
    state.set_cursor(conn.name, _PREVIOUS_CURSOR)
    fetched, pushed = _generic_poll_world(monkeypatch, 5_001)

    await _poll_job(SETTINGS, conn, state)

    # The whole source was read in the one run, and nothing about its length was a failure…
    assert fetched == [_PREVIOUS_CURSOR]
    assert len(pushed) == 5_001 and pushed[-1] == "github/o/r/doc-5001.md"
    # …so the cursor moved on.
    advanced = state.get_cursor(conn.name)
    assert advanced is not None and advanced > _PREVIOUS_CURSOR
    state.close()


async def test_generic_poll_with_a_sink_failure_keeps_its_cursor(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "generic-cursor-failure.sqlite"))
    conn = Connection(name="nt", source="notion", options={"token": "t", "page_ids": ["p"]})
    state.set_cursor(conn.name, _PREVIOUS_CURSOR)
    fetched, pushed = _generic_poll_world(monkeypatch, 40, failing="github/o/r/doc-7.md")

    await _poll_job(SETTINGS, conn, state)

    assert fetched == [_PREVIOUS_CURSOR] and len(pushed) == 40
    # A document the brain did not take is re-polled: the cursor stays where it was.
    assert state.get_cursor(conn.name) == _PREVIOUS_CURSOR
    state.close()


def _oauth_row(integration_id, name, **overrides):
    return {
        "id": integration_id, "type": "gdrive", "name": name, "status": "enabled",
        "config": {"authMode": "oauth", "fileIds": ["Doc"], "selectionState": "selected",
                   "authenticatedAccountId": "subject:google-123"},
        **overrides,
    }


async def test_remote_poll_runs_only_unconfigured_enabled_oauth_selections(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "remote-poll.sqlite"))
    admin_id = "00000000-0000-0000-0000-00000000000a"
    later_id = "00000000-0000-0000-0000-00000000000b"
    local = Connection("local-docs", "gdrive", options={"service_account_key_path": "local.json"})
    ran, reported = [], []

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def fetch_integration_selections(self, **kwargs):
            assert kwargs == {"include_disabled": True}
            return [
                _oauth_row(admin_id, "admin-docs"),
                _oauth_row("00000000-0000-0000-0000-00000000000c", "paused", status="disabled"),
                _oauth_row("00000000-0000-0000-0000-00000000000d", "sa-docs",
                           config={"authMode": "service_account"}),
                _oauth_row("00000000-0000-0000-0000-00000000000e", "local-docs"),
                _oauth_row("00000000-0000-0000-0000-00000000000f", "admin-docs", type="slack"),
                _oauth_row(later_id, "later-docs"),
            ]
        async def report_scheduled_gdrive_run(self, report_id, integration_id, started, summary, **kwargs):
            reported.append({
                "integration_id": integration_id, "status": kwargs["status"], "error": kwargs.get("error"),
                "failed": summary.failed, "authoritative_complete": summary.authoritative_complete,
                "failure_categories": dict(summary.failure_categories or {}),
            })

    async def run(_settings, conn, _state):
        ran.append(conn)
        if conn.name == "admin-docs":
            raise RuntimeError("first integration failed: do-not-leak-marker")
        return IngestSummary(conn.name, backlog=0, authoritative_complete=True,
                             integration_id=conn.options["integration_id"])

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.scheduler.run_gdrive_stream", run)
    await _remote_gdrive_poll_job(SETTINGS, [local], state)

    # Paused, service-account and non-Drive rows never bootstrap; the locally configured name stays
    # with its own poll job; one integration's failure does not starve the next.
    assert [conn.name for conn in ran] == ["admin-docs", "later-docs"]
    assert [conn.options["integration_id"] for conn in ran] == [admin_id, later_id]
    for conn in ran:
        assert conn.options["auth_mode"] == "oauth"
        assert conn.options["credential_identity"] == "subject:google-123"
        assert not {"service_account_key_path", "credential_json", "access_token"} & set(conn.options)
    # The integration whose run RAISED (still enabled on the re-read) is reported once, against its
    # resolved id, as a sanitized non-authoritative failure under the fixed category — never the
    # exception's text or class — and the later integration still runs and completes.
    assert [(r["integration_id"], r["status"]) for r in reported] == [(admin_id, "failed"), (later_id, "complete")]
    failed, completed = reported
    assert failed == {
        "integration_id": admin_id, "status": "failed", "error": "coordinator_error",
        "failed": 1, "authoritative_complete": False, "failure_categories": {"coordinator_error": 1},
    }
    assert "do-not-leak-marker" not in repr(failed) and "RuntimeError" not in repr(failed)
    assert completed["error"] is None and completed["authoritative_complete"] is True and completed["failed"] == 0
    state.close()


async def test_remote_poll_fails_closed_when_selections_cannot_be_read(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "remote-poll-unreadable.sqlite"))
    ran = []

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def fetch_integration_selections(self, **kwargs):
            raise BrainError(503, "unavailable", "selection read failed")

    async def run(_settings, conn, _state):
        ran.append(conn)

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.scheduler.run_gdrive_stream", run)
    with pytest.raises(BrainError):
        await _remote_gdrive_poll_job(SETTINGS, [], state)
    assert ran == []
    state.close()


@pytest.mark.parametrize("configured", [False, True])
async def test_manual_request_runs_oauth_only_connection_without_a_local_stub(
    tmp_path, monkeypatch, configured,
):
    state = StateStore(str(tmp_path / "manual.sqlite"))
    integration_id = "00000000-0000-0000-0000-00000000000a"
    request = GdriveRunRequest(
        "request-1", integration_id, "admin-docs", "manual", NOW, "00000000-0000-0000-0000-0000000000a1",
    )
    local = Connection("admin-docs", "gdrive", options={"service_account_key_path": "local.json"})
    other = Connection("other-docs", "gdrive", options={"service_account_key_path": "other.json"})
    ran, completed = [], []

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def claim_gdrive_run_request(self):
            return request
        async def complete_gdrive_run_request(self, claimed, summary, **kwargs):
            completed.append((claimed, summary.connection, kwargs["status"], kwargs["error"]))

    async def run(_settings, conn, _state):
        ran.append(conn)
        return IngestSummary(conn.name, backlog=0, authoritative_complete=True)

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.scheduler.run_gdrive_stream", run)
    await _manual_gdrive_job(SETTINGS, [other, local] if configured else [other], state)

    assert completed == [(request, "admin-docs", "complete", None)]
    # An explicit Admin run re-arms exhausted retries (AIO-1167 R44 C7).
    if configured:
        # A same-named local connection keeps the request; it is never replaced by a broker stub.
        # Name-only, it is bound to the request's immutable id (R44 C11).
        assert [(conn.name, conn.options) for conn in ran] == [
            ("admin-docs", {**local.options, "integration_id": integration_id, "rearm_exhausted": True}),
        ]
    else:
        assert [(conn.name, conn.source, conn.options) for conn in ran] == [
            ("admin-docs", "gdrive", {"integration_id": integration_id, "auth_mode": "oauth", "rearm_exhausted": True}),
        ]
    state.close()


async def test_renewal_job_rereads_pause_after_scheduler_start(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "paused.sqlite"))
    conn = Connection(name="gd", source="gdrive", options={"api_mode": "docs"})
    state.save_channel(Channel("gd", "old-ch", "resource", "2000-01-01T00:00:00+00:00"))

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def fetch_integration_selections(self, **kwargs):
            return [{"type": "gdrive", "name": "gd", "status": "disabled", "config": {}}]

    class Watch:
        calls = 0
        def renew(self, channel, page_token=None):
            self.calls += 1
            return channel

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    watch = Watch()
    await _renewal_job(state, watch, [conn], SETTINGS)
    assert watch.calls == 0
    assert state.get_channel("gd") is None  # expired local bookkeeping may retire; no provider call occurs
    state.close()



def _watch_response(record):
    expiration = int((datetime.now(timezone.utc) + timedelta(days=6)).timestamp() * 1000)
    return {"id": record.attempt_id, "resourceId": f"resource-{record.drive_id}", "expiration": str(expiration)}


def _watch_states(payload):
    return tuple(sorted(r["state"] for r in payload.get("watches", {}).get("records", [])))


async def test_oauth_watch_renewal_uses_execution_broker_and_fences_publication(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "oauth-watch.sqlite"))
    integration_id = "00000000-0000-0000-0000-000000000001"
    conn = Connection(name="gd", source="gdrive", options={"webhook_url": "https://example.test/watch"})
    progress = state.begin_generation(StreamKey("demo", integration_id, "acct"), 3,
                                      start_token="consume-from-here")
    state.update_progress(progress.namespace, page_token="consume-from-here", phase="current")
    state.save_channel(Channel("gd", "old", "resource", "2000-01-01T00:00:00+00:00", progress.namespace))
    events = []

    class Client:
        revision = 7
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def fetch_integration_selections(self, **kwargs):
            return [{"id": integration_id, "type": "gdrive", "name": "gd", "status": "enabled"}]
        async def acquire_gdrive_execution(self, requested, owner):
            events.append("acquire")
            return GdriveExecution(requested, 3, 4, owner, "later", "hash",
                                   {"authMode": "oauth", "authenticatedAccountId": "acct"},
                                   {"drive_id": "my-drive", "page_token": "consume-from-here"}, 7)
        async def broker_gdrive_access_token(self, execution):
            events.append("broker")
            return {"access_token": "memory-only"}
        async def checkpoint_gdrive_execution(self, execution, payload):
            # Renewal never moves the cursor: every checkpoint carries it unchanged.
            events.append(("checkpoint", payload["page_token"], _watch_states(payload)))
            assert "memory-only" not in json.dumps(payload)
            Client.revision += 1
            return {"progress_revision": Client.revision}
        async def release_gdrive_execution(self, execution):
            events.append("release")
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): events.append("gate")
                def close(self): events.append("gate-close")
            return Gate()

    class Watch:
        def ttl_seconds(self, _name): return 7 * 86_400
        def dispatch(self, record, *, page_token, verification_token, access_token=None,
                     provider_gate=None, deadline=None):
            provider_gate()
            events.append(("dispatch", page_token, access_token, record.drive_id, record.predecessor))
            return _watch_response(record)

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    await _renewal_job(state, Watch(), [conn], SETTINGS)
    assert events[:2] == ["acquire", "broker"]
    assert events[2:5] == [
        ("checkpoint", "consume-from-here", ("prepared",)),
        ("checkpoint", "consume-from-here", ("dispatched",)),
        "gate",
    ]
    # The brokered token reaches the provider only; the old local channel is the predecessor.
    assert events[5] == ("dispatch", "consume-from-here", "memory-only", "my-drive", "old")
    assert events[6] == ("checkpoint", "consume-from-here", ("active",))
    assert state.get_channel("gd").resource_id == "resource-my-drive"
    assert events[-1] == "release" and events.count("release") == 1
    state.close()


async def test_watch_renewal_ignores_stale_account_scope_and_drive_namespaces(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "watch-current-authority.sqlite"))
    integration_id = "00000000-0000-0000-0000-000000000001"
    conn = Connection(name="gd", source="gdrive", options={"webhook_url": "https://example.test/watch"})
    stale_account = StreamKey("demo", integration_id, "old-account", "drive-current").namespace(8)
    stale_drive = StreamKey("demo", integration_id, "account-current", "drive-old").namespace(9)
    state.save_channel(Channel("gd", "stale-account", "one", "2099-01-01T00:00:00+00:00", stale_account))
    state.save_channel(Channel("gd", "stale-drive", "two", "2099-01-01T00:00:00+00:00", stale_drive))
    seen = []

    class Client:
        revision = 11
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def fetch_integration_selections(self, **kwargs):
            return [{"id": integration_id, "type": "gdrive", "name": "gd", "status": "enabled"}]
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(
                requested, 9, 5, owner, "later", "new-scope",
                {"authMode": "oauth", "authenticatedAccountId": "account-current",
                 "fileIds": ["Current"], "selectionState": "selected"},
                {"drive_id": "drive-current", "page_token": "server-current-token"}, 11,
            )
        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory-only"}
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, payload):
            seen.append(("checkpoint", payload["drive_id"], payload["page_token"]))
            Client.revision += 1
            return {"progress_revision": Client.revision}
        async def release_gdrive_execution(self, execution):
            seen.append(("release", execution.generation))

    class Watch:
        def ttl_seconds(self, _name): return 7 * 86_400
        def dispatch(self, record, *, page_token, verification_token, access_token=None,
                     provider_gate=None, deadline=None):
            seen.append(("dispatch", record.predecessor, record.namespace, page_token, record.drive_id))
            return _watch_response(record)

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    await _renewal_job(state, Watch(), [conn], SETTINGS)

    current_namespace = StreamKey(
        "demo", integration_id, "account-current", "drive-current",
    ).namespace(9)
    # Channels of an older account or drive namespace are neither renewed nor predecessors.
    assert ("dispatch", None, current_namespace, "server-current-token", "drive-current") in seen
    assert ("checkpoint", "drive-current", "server-current-token") in seen
    assert ("release", 9) in seen
    current = [c for c in state.list_channels("gd") if c.namespace == current_namespace]
    assert len(current) == 1 and current[0].resource_id == "resource-drive-current"
    state.close()


async def test_watch_renewal_covers_each_authoritative_v2_stream(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "watch-multi-stream.sqlite"))
    integration_id = "00000000-0000-0000-0000-000000000001"
    conn = Connection(name="gd", source="gdrive", options={"webhook_url": "https://example.test/watch"})
    renewed = []
    streams = {
        "my-drive": {"drive_id": "my-drive", "page_token": "my-token"},
        "shared-a": {"drive_id": "shared-a", "page_token": "a-token"},
        "shared-b": {"drive_id": "shared-b", "page_token": "b-token"},
    }

    class Client:
        revision = 20
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def fetch_integration_selections(self, **kwargs):
            return [{"id": integration_id, "type": "gdrive", "name": "gd", "status": "enabled"}]
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(
                requested, 3, 2, owner, "later", "scope",
                {"authMode": "oauth", "authenticatedAccountId": "account",
                 "fileIds": ["doc"], "sharedDriveIds": ["shared-a", "shared-b"],
                 "selectionState": "selected"},
                {"version": 2, "streams": json.loads(json.dumps(streams))}, 19,
            )
        async def broker_gdrive_access_token(self, execution): return {"access_token": "memory"}
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, payload):
            # No stream record is ever changed by renewal.
            assert payload["streams"] == streams
            Client.revision += 1
            return {"progress_revision": Client.revision, "progress": payload}
        async def release_gdrive_execution(self, execution): pass

    class Watch:
        def ttl_seconds(self, _name): return 7 * 86_400
        def dispatch(self, record, *, page_token, verification_token, access_token=None,
                     provider_gate=None, deadline=None):
            renewed.append((record.drive_id, page_token, record.namespace))
            return _watch_response(record)

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    await _renewal_job(state, Watch(), [conn], SETTINGS)

    assert [(drive, token) for drive, token, _ in renewed] == [
        ("my-drive", "my-token"), ("shared-a", "a-token"), ("shared-b", "b-token"),
    ]
    assert len({namespace for _, _, namespace in renewed}) == 3
    assert {channel.resource_id for channel in state.list_channels("gd")} == {
        "resource-my-drive", "resource-shared-a", "resource-shared-b",
    }
    state.close()


@pytest.mark.parametrize("failure_stage", ["broker", "provider", "checkpoint", "local-save"])
async def test_watch_releases_acquired_authority_after_every_failure_stage(
    tmp_path, monkeypatch, failure_stage,
):
    state = StateStore(str(tmp_path / f"watch-{failure_stage}.sqlite"))
    integration_id = "00000000-0000-0000-0000-000000000001"
    conn = Connection(name="gd", source="gdrive", options={"webhook_url": "https://example.test/watch"})
    events = []

    class Client:
        revision = 3
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def fetch_integration_selections(self, **kwargs):
            return [{"id": integration_id, "type": "gdrive", "name": "gd", "status": "enabled"}]
        async def acquire_gdrive_execution(self, requested, owner):
            events.append("acquire")
            return GdriveExecution(
                requested, 4, 2, owner, "later", "scope",
                {"authMode": "oauth", "authenticatedAccountId": "account",
                 "fileIds": ["Current"], "selectionState": "selected"},
                {"drive_id": "drive", "page_token": "cursor"}, 3,
            )
        async def broker_gdrive_access_token(self, execution):
            events.append("broker")
            if failure_stage == "broker":
                raise RuntimeError("broker failed")
            return {"access_token": "memory-only"}
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): events.append("gate")
                def close(self): events.append("gate-close")
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, payload):
            events.append("checkpoint")
            if failure_stage == "checkpoint":
                raise RuntimeError("checkpoint failed")
            Client.revision += 1
            return {"progress_revision": Client.revision}
        async def release_gdrive_execution(self, execution):
            events.append("release")
            raise RuntimeError("release also failed")

    class Watch:
        def ttl_seconds(self, _name): return 7 * 86_400
        def dispatch(self, record, *, page_token, verification_token, access_token=None,
                     provider_gate=None, deadline=None):
            events.append("provider")
            if failure_stage == "provider":
                raise RuntimeError("provider failed")
            provider_gate()
            return _watch_response(record)

    if failure_stage == "local-save":
        def fail_save(_record):
            events.append("local-save")
            raise OSError("disk failed")
        monkeypatch.setattr(state, "save_watch_record", fail_save)
    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)

    await _renewal_job(state, Watch(), [conn], SETTINGS)

    assert events[0] == "acquire"
    assert events[-1] == "release"
    assert events.count("release") == 1
    if failure_stage in ("broker", "checkpoint", "local-save"):
        assert "provider" not in events  # nothing is dispatched without a durable intent
    if failure_stage == "local-save":
        assert events.index("checkpoint") < events.index("local-save") < events.index("release")
    state.close()
