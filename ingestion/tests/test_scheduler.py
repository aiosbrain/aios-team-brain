from aios_ingest.config import BrainSettings, Connection
from aios_ingest.scheduler import (
    build_scheduler, due_for_renewal, _renewal_job, _gdrive_outcome_status,
    _manual_gdrive_job, _remote_gdrive_poll_job,
)
from aios_ingest.engine import IngestSummary
from aios_ingest.state import Channel, StateStore, StreamKey
from aios_ingest.brain_client import BrainError, GdriveExecution, GdriveRunRequest
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
    assert ids == {"poll:gd", "gdrive-manual-queue", "renewal-sweep"}
    state.close()


def test_build_scheduler_bootstraps_remote_gdrive_without_a_local_connection(tmp_path):
    state = StateStore(str(tmp_path / "s.sqlite"))
    assert build_scheduler(SETTINGS, [], state=state).get_jobs() == []
    sched = build_scheduler(SETTINGS, [], state=state, bootstrap_remote_gdrive=True)
    assert {j.id for j in sched.get_jobs()} == {"gdrive-manual-queue", "gdrive-remote-poll"}
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
            reported.append((integration_id, kwargs["status"]))

    async def run(_settings, conn, _state):
        ran.append(conn)
        if conn.name == "admin-docs":
            raise RuntimeError("first integration failed")
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
    assert reported == [(later_id, "complete")]
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
    request = GdriveRunRequest("request-1", integration_id, "admin-docs", "manual", NOW)
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
    if configured:
        # A same-named local connection keeps the request; it is never replaced by a broker stub.
        assert ran == [local]
    else:
        assert [(conn.name, conn.source, conn.options) for conn in ran] == [
            ("admin-docs", "gdrive", {"integration_id": integration_id, "auth_mode": "oauth"}),
        ]
    state.close()


async def test_renewal_job_renews_due_channels(tmp_path):
    state = StateStore(str(tmp_path / "s.sqlite"))
    conn = Connection(name="gd", source="gdrive", options={"folder_id": "f"})
    # An already-expired channel must be renewed.
    state.save_channel(Channel("gd", "old-ch", "tok", "2000-01-01T00:00:00+00:00"))

    class FakeWatch:
        def renew(self, channel, page_token=None):
            return Channel(channel.connection, "new-ch", "tok2", "2099-01-01T00:00:00+00:00")

    await _renewal_job(state, FakeWatch(), [conn])
    refreshed = state.get_channel("gd")
    assert refreshed.channel_id == "new-ch"
    assert refreshed.expires_at == "2099-01-01T00:00:00+00:00"
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
            events.append(("checkpoint", payload["page_token"], payload["watch_channel_id"]))
            return {"progress_revision": 8}
        async def release_gdrive_execution(self, execution):
            events.append("release")
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): events.append("gate")
                def close(self): events.append("gate-close")
            return Gate()

    class Watch:
        def renew(self, channel, page_token=None, access_token=None, provider_gate=None, drive_id=None):
            provider_gate()
            events.append(("renew", page_token, access_token, drive_id))
            return Channel("gd", "new", "new-resource", "2099-01-01T00:00:00+00:00", channel.namespace)

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    await _renewal_job(state, Watch(), [conn], SETTINGS)
    assert events[:4] == ["acquire", "broker", "gate", ("renew", "consume-from-here", "memory-only", "my-drive")]
    assert events[4] == ("checkpoint", "consume-from-here", "new")
    assert state.get_channel("gd").channel_id == "new"
    assert "release" in events
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
            return {"progress_revision": 12}
        async def release_gdrive_execution(self, execution):
            seen.append(("release", execution.generation))

    class Watch:
        def renew(self, channel, page_token=None, access_token=None, provider_gate=None, drive_id=None):
            seen.append(("renew", channel.channel_id, channel.namespace, page_token, drive_id))
            return Channel("gd", "current", "resource", "2099-02-01T00:00:00+00:00", channel.namespace)

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    await _renewal_job(state, Watch(), [conn], SETTINGS)

    current_namespace = StreamKey(
        "demo", integration_id, "account-current", "drive-current",
    ).namespace(9)
    assert ("renew", "bootstrap", current_namespace, "server-current-token", "drive-current") in seen
    assert ("checkpoint", "drive-current", "server-current-token") in seen
    assert ("release", 9) in seen
    assert state.get_channel("gd").channel_id == "current"
    state.close()


async def test_watch_renewal_covers_each_authoritative_v2_stream(tmp_path, monkeypatch):
    state = StateStore(str(tmp_path / "watch-multi-stream.sqlite"))
    integration_id = "00000000-0000-0000-0000-000000000001"
    conn = Connection(name="gd", source="gdrive", options={"webhook_url": "https://example.test/watch"})
    renewed = []

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
                {"version": 2, "streams": {
                    "my-drive": {"drive_id": "my-drive", "page_token": "my-token"},
                    "shared-a": {"drive_id": "shared-a", "page_token": "a-token"},
                    "shared-b": {"drive_id": "shared-b", "page_token": "b-token"},
                }}, 19,
            )
        async def broker_gdrive_access_token(self, execution): return {"access_token": "memory"}
        def gdrive_provider_gate(self, execution):
            class Gate:
                def close(self): pass
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": payload}
        async def release_gdrive_execution(self, execution): pass

    class Watch:
        def renew(self, channel, page_token=None, access_token=None, provider_gate=None, drive_id=None):
            renewed.append((drive_id, page_token, channel.namespace))
            return Channel("gd", f"channel-{drive_id}", f"resource-{drive_id}",
                           "2099-02-01T00:00:00+00:00", channel.namespace)

    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
    await _renewal_job(state, Watch(), [conn], SETTINGS)

    assert [(drive, token) for drive, token, _ in renewed] == [
        ("my-drive", "my-token"), ("shared-a", "a-token"), ("shared-b", "b-token"),
    ]
    assert len({namespace for _, _, namespace in renewed}) == 3
    assert {channel.channel_id for channel in state.list_channels("gd")} == {
        "channel-my-drive", "channel-shared-a", "channel-shared-b",
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
            return {"progress_revision": 4}
        async def release_gdrive_execution(self, execution):
            events.append("release")
            raise RuntimeError("release also failed")

    class Watch:
        def renew(self, channel, page_token=None, access_token=None, provider_gate=None, drive_id=None):
            events.append("provider")
            if failure_stage == "provider":
                raise RuntimeError("provider failed")
            provider_gate()
            return Channel("gd", "new", "resource", "2099-01-01T00:00:00+00:00", channel.namespace)

    if failure_stage == "local-save":
        def fail_save(_channel):
            events.append("local-save")
            raise OSError("disk failed")
        monkeypatch.setattr(state, "save_channel", fail_save)
    monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)

    await _renewal_job(state, Watch(), [conn], SETTINGS)

    assert events[0] == "acquire"
    assert events[-1] == "release"
    assert events.count("release") == 1
    if failure_stage == "local-save":
        assert events.index("checkpoint") < events.index("local-save") < events.index("release")
    state.close()
