from aios_ingest.config import BrainSettings, Connection
from aios_ingest.scheduler import build_scheduler, due_for_renewal, _renewal_job, _gdrive_outcome_status
from aios_ingest.engine import IngestSummary
from aios_ingest.state import Channel, StateStore, StreamKey
from aios_ingest.brain_client import GdriveExecution
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
