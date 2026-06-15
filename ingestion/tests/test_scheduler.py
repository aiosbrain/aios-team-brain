from aios_ingest.config import BrainSettings, Connection
from aios_ingest.scheduler import build_scheduler, due_for_renewal, _renewal_job
from aios_ingest.state import Channel, StateStore

SETTINGS = BrainSettings(base_url="http://brain", api_key="aios_a_b", team="demo")
NOW = "2026-06-14T12:00:00+00:00"


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
        def renew(self, channel):  # pragma: no cover - not invoked here
            return channel

    sched = build_scheduler(SETTINGS, conns, state=state, watch_manager=FakeWatch())
    ids = {j.id for j in sched.get_jobs()}
    assert ids == {"poll:gd", "renewal-sweep"}
    state.close()


async def test_renewal_job_renews_due_channels(tmp_path):
    state = StateStore(str(tmp_path / "s.sqlite"))
    conn = Connection(name="gd", source="gdrive", options={"folder_id": "f"})
    # An already-expired channel must be renewed.
    state.save_channel(Channel("gd", "old-ch", "tok", "2000-01-01T00:00:00+00:00"))

    class FakeWatch:
        def renew(self, channel):
            return Channel(channel.connection, "new-ch", "tok2", "2099-01-01T00:00:00+00:00")

    await _renewal_job(state, FakeWatch(), [conn])
    refreshed = state.get_channel("gd")
    assert refreshed.channel_id == "new-ch"
    assert refreshed.expires_at == "2099-01-01T00:00:00+00:00"
    state.close()
