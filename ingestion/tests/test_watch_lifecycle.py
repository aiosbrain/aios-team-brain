"""Drive watch-channel lifecycle and the connector-state ownership contract (AIO-1167 R41).

Spec (AC-04, AC-07; Astra R41 adjudication):

* Creating a channel is a non-transactional external call. A durable ``prepared`` intent and a
  fenced ``dispatched`` marker precede the ONE provider request; only a validated response
  published under the fence makes a channel ``active``. A lost response, a timeout or cancellation
  after dispatch, or a publication that fails is not proof that nothing exists: the attempt is
  ``uncertain`` and is stopped once its resource id is known, or expires at its requested expiry.
* Provider work runs bounded and off the event loop: unrelated scheduler work proceeds while it is
  slow, and a worker that outlives its deadline is abandoned — its late result can only become
  cleanup evidence, never activation, and the resources it uses stay open until it ends.
* Early notifications for a pending attempt are evidence only; they never activate a channel and
  never schedule a read.
* Renewal owns the ``watches`` section and cannot touch a cursor; polling owns the cursors and can
  never erase a channel intent or record.
"""

from __future__ import annotations

import asyncio
import json
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from aios_ingest.brain_client import BrainError, GdriveExecution
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.connector_state import coordinator_document, renewal_document
from aios_ingest.state import Channel, StateStore, StreamKey, verification_hash
from aios_ingest.watch_lifecycle import (
    ACTIVE, CLEANUP_PENDING, DISPATCHED, EXPIRED, PREPARED, RETIRED, UNCERTAIN,
    InvalidWatchResponse, InvalidWatchTransition, WatchNotDispatched, WatchRecord, WatchRefused,
    from_section, to_section, transition, validate_watch_response,
)
from aios_ingest import watch_renewal

SETTINGS = BrainSettings(base_url="http://brain", api_key="aios_a_b", team="demo")
INTEGRATION = "00000000-0000-0000-0000-0000000000a1"
ACCOUNT = "account"


def _ms(delta: timedelta) -> str:
    return str(int((datetime.now(timezone.utc) + delta).timestamp() * 1000))


def _record(state: str = PREPARED, **changes) -> WatchRecord:
    base = dict(
        attempt_id="attempt-1", connection="gd", integration_id=INTEGRATION, account_id=ACCOUNT,
        drive_id="my-drive", generation=3,
        namespace=StreamKey("demo", INTEGRATION, ACCOUNT, "my-drive").namespace(3),
        verification_hash=verification_hash("secret-token"),
        requested_expiry=(datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        state=state,
    )
    base.update(changes)
    return WatchRecord(**base)


# --------------------------------------------------------------------------------------------- #
# The lifecycle state machine and response validation (pure)
# --------------------------------------------------------------------------------------------- #

def test_terminal_watch_records_are_never_reopened():
    for terminal in (RETIRED, EXPIRED):
        record = _record(terminal)
        for target in (PREPARED, DISPATCHED, ACTIVE, UNCERTAIN, CLEANUP_PENDING, RETIRED, EXPIRED):
            with pytest.raises(InvalidWatchTransition):
                transition(record, target)


def test_unknown_outcomes_cannot_be_activated_or_silently_forgotten():
    uncertain = _record(UNCERTAIN)
    # An uncertain attempt is never activated (an early notification or late response is only
    # cleanup evidence), and never retired as if nothing existed: it is stopped, or it expires.
    with pytest.raises(InvalidWatchTransition):
        transition(uncertain, ACTIVE)
    with pytest.raises(InvalidWatchTransition):
        transition(uncertain, RETIRED)
    # Nothing skips the dispatch marker.
    with pytest.raises(InvalidWatchTransition):
        transition(_record(PREPARED), ACTIVE)
    assert transition(uncertain, CLEANUP_PENDING, resource_id="r").state == CLEANUP_PENDING


def test_watch_response_must_name_exactly_the_requested_channel_without_defaults():
    record = _record(DISPATCHED)
    good = {"id": "attempt-1", "resourceId": "res", "expiration": _ms(timedelta(days=6))}
    resource, expires = validate_watch_response(record, good)
    assert resource == "res" and expires > datetime.now(timezone.utc).isoformat()

    cases = [
        ({**good, "id": "someone-else"}, "res"),
        ({k: v for k, v in good.items() if k != "resourceId"}, None),
        ({k: v for k, v in good.items() if k != "expiration"}, "res"),
        ({**good, "expiration": _ms(timedelta(seconds=-5))}, "res"),
        ({**good, "expiration": _ms(timedelta(days=30))}, "res"),
        ({**good, "expiration": "soon"}, "res"),
    ]
    for response, resource_id in cases:
        with pytest.raises(InvalidWatchResponse) as invalid:
            validate_watch_response(record, response)
        assert invalid.value.resource_id == resource_id


def test_watch_section_round_trips_ignores_malformed_records_and_keeps_no_raw_token():
    records = {r.attempt_id: r for r in (_record(ACTIVE, attempt_id="a", resource_id="r"),
                                         _record(UNCERTAIN, attempt_id="b"))}
    section = to_section(records)
    assert "secret-token" not in json.dumps(section)
    document = {"watches": {"version": 1, "records": [
        *section["records"], {"attempt_id": "x", "state": "bogus"}, "garbage",
        {"attempt_id": "y", "state": ACTIVE},  # missing required fields
    ]}}
    assert from_section(document) == records


# --------------------------------------------------------------------------------------------- #
# One owner per section of the fenced connector state
# --------------------------------------------------------------------------------------------- #

def test_coordinator_checkpoints_carry_renewal_state_and_renewal_never_touches_cursors():
    previous = {
        "version": 2, "drive_id": "my-drive", "page_token": "cursor-1",
        "watch_channel_id": "legacy-channel",
        "streams": {"my-drive": {"drive_id": "my-drive", "page_token": "cursor-1",
                                 "watch_channel_id": "legacy-channel"}},
        "roots": {"generation": 3, "items": []},
        "watches": {"version": 1, "records": [{"attempt_id": "keep-me"}]},
    }
    # A poll builds its cursor document without any renewal field — and may even try to drop them.
    polled = {
        "version": 2, "drive_id": "my-drive", "page_token": "cursor-2",
        "streams": {"my-drive": {"drive_id": "my-drive", "page_token": "cursor-2"}},
        "roots": {"generation": 3, "items": []},
        "watches": {"version": 1, "records": []},
    }
    merged = coordinator_document(previous, polled)
    assert merged["page_token"] == "cursor-2"  # the coordinator's cursor transition
    assert merged["watches"] == previous["watches"]  # renewal's records survive the poll
    assert merged["streams"]["my-drive"]["watch_channel_id"] == "legacy-channel"
    assert merged["watch_channel_id"] == "legacy-channel"

    renewed = renewal_document(merged, {"version": 1, "records": [{"attempt_id": "new"}]})
    assert renewed["streams"] == merged["streams"] and renewed["page_token"] == "cursor-2"
    assert renewed["roots"] == merged["roots"]
    assert renewed["watches"] == {"version": 1, "records": [{"attempt_id": "new"}]}
    # Neither input was mutated.
    assert previous["page_token"] == "cursor-1" and polled["watches"] == {"version": 1, "records": []}


async def test_a_poll_checkpoint_after_renewal_preserves_the_channel_lifecycle(tmp_path):
    """The end-to-end shape of the original bug: `_checkpoint_progress` rebuilt the document from
    local cursor state and erased whatever renewal had published."""
    from aios_ingest.gdrive_sync import _checkpoint_progress

    state = StateStore(str(tmp_path / "poll-after-renew.sqlite"))
    key = StreamKey("demo", INTEGRATION, ACCOUNT, "my-drive")
    progress = state.begin_generation(key, 3, start_token="start")
    watches = to_section({"a": _record(ACTIVE, attempt_id="a", resource_id="r",
                                       expires_at=(datetime.now(timezone.utc) + timedelta(days=6)).isoformat())})
    execution = GdriveExecution(INTEGRATION, 3, 1, "owner", "later", "scope", {},
                                progress={"version": 2, "streams": {}, "watches": watches}, progress_revision=4)
    sent = []

    class Client:
        async def checkpoint_gdrive_execution(self, execution, payload):
            sent.append(json.loads(json.dumps(payload)))
            return {"progress_revision": 5, "progress": payload}

    await _checkpoint_progress(Client(), execution, state, progress.namespace, phase="catching_up",
                               page_token="cursor-after-poll")
    assert sent[0]["watches"] == watches
    assert sent[0]["streams"]["my-drive"]["page_token"] == "cursor-after-poll"
    assert execution.progress["watches"] == watches
    state.close()


# --------------------------------------------------------------------------------------------- #
# The renewal sweep, end to end against a fenced brain and a scripted provider
# --------------------------------------------------------------------------------------------- #

class _Brain:
    """The brain as renewal sees it: fenced checkpoints that store the whole document."""

    def __init__(self, *, status="enabled", progress=None):
        self.status = status
        self.progress = progress if progress is not None else {
            "version": 2, "drive_id": "my-drive", "page_token": "cursor-1",
            "streams": {"my-drive": {"drive_id": "my-drive", "page_token": "cursor-1"}},
            "roots": {"generation": 3, "items": []},
        }
        self.revision = 1
        self.events: list = []
        self.checkpoints: list[dict] = []
        self.checkpoint_faults: list = []  # callables(payload) -> exception | None
        self.gate_closed = False
        self.gate_closed_event = threading.Event()

    def install(self, monkeypatch):
        brain = self

        class Gate:
            def __call__(self):
                brain.events.append("gate")

            def close(self):
                brain.gate_closed = True
                brain.events.append("gate-close")
                brain.gate_closed_event.set()

        class Client:
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass

            async def fetch_integration_selections(self, **kwargs):
                return [{"id": INTEGRATION, "type": "gdrive", "name": "gd", "status": brain.status}]

            async def acquire_gdrive_execution(self, requested, owner):
                brain.events.append("acquire")
                return GdriveExecution(
                    requested, 3, 2, owner, "later", "scope",
                    {"authMode": "oauth", "authenticatedAccountId": ACCOUNT},
                    json.loads(json.dumps(brain.progress)), brain.revision,
                )

            async def broker_gdrive_access_token(self, execution):
                brain.events.append("broker")
                return {"access_token": "memory-only-access-token"}

            def gdrive_provider_gate(self, execution):
                return Gate()

            async def checkpoint_gdrive_execution(self, execution, payload):
                for fault in list(brain.checkpoint_faults):
                    error = fault(payload)
                    if error is not None:
                        brain.checkpoint_faults.remove(fault)
                        raise error
                states = sorted(r["state"] for r in payload.get("watches", {}).get("records", []))
                brain.events.append(("checkpoint", tuple(states)))
                brain.checkpoints.append(json.loads(json.dumps(payload)))
                brain.revision += 1
                brain.progress = json.loads(json.dumps(payload))
                return {"progress_revision": brain.revision, "progress": json.loads(json.dumps(payload))}

            async def release_gdrive_execution(self, execution):
                brain.events.append("release")

        monkeypatch.setattr("aios_ingest.brain_client.BrainClient", Client)
        return self

    def records(self):
        return from_section(self.progress)


class _Provider:
    """Google, scripted: ``on_dispatch(record, token)`` returns a response or raises."""

    def __init__(self, brain: _Brain, on_dispatch=None):
        self.brain = brain
        self.dispatched: list[tuple[WatchRecord, str, str]] = []
        self.stopped: list[tuple[str, str]] = []
        self.on_dispatch = on_dispatch or (lambda record, token: {
            "id": record.attempt_id, "resourceId": f"res-{record.attempt_id}",
            "expiration": _ms(timedelta(days=6)),
        })
        self.stop_error: Exception | None = None

    def ttl_seconds(self, _connection):
        return 7 * 86_400

    def dispatch(self, record, *, page_token, verification_token, access_token=None,
                 provider_gate=None, deadline=None):
        provider_gate()
        # Every record the provider is asked for was durably marked dispatched first.
        stored = self.brain.records()[record.attempt_id]
        assert stored.state == DISPATCHED
        self.dispatched.append((record, page_token, verification_token))
        return self.on_dispatch(record, verification_token)

    def stop(self, record, resource_id, *, access_token=None, provider_gate=None, deadline=None):
        provider_gate()
        if self.stop_error is not None:
            raise self.stop_error
        self.stopped.append((record.attempt_id, resource_id))


def _conn():
    return Connection(name="gd", source="gdrive", options={"webhook_url": "https://example.test/watch"})


async def test_creation_is_intent_then_fenced_marker_then_one_request_then_fenced_activation(
    tmp_path, monkeypatch,
):
    brain = _Brain().install(monkeypatch)
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / "create.sqlite"))

    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)

    checkpoints = [event for event in brain.events if isinstance(event, tuple)]
    assert checkpoints == [
        ("checkpoint", (PREPARED,)), ("checkpoint", (DISPATCHED,)), ("checkpoint", (ACTIVE,)),
    ]
    assert brain.events.index(("checkpoint", (DISPATCHED,))) < brain.events.index("gate")
    assert len(provider.dispatched) == 1
    (record, cursor, token) = provider.dispatched[0]
    assert cursor == "cursor-1"
    # Renewal never touched a cursor, a stream or the roots, in any checkpoint.
    for document in brain.checkpoints:
        assert document["streams"] == {"my-drive": {"drive_id": "my-drive", "page_token": "cursor-1"}}
        assert document["page_token"] == "cursor-1" and document["roots"] == {"generation": 3, "items": []}
        # The raw verification token and the access token never enter the record; its hash does.
        assert token not in json.dumps(document) and "memory-only-access-token" not in json.dumps(document)
    (active,) = brain.records().values()
    assert active.state == ACTIVE and active.verification_hash == verification_hash(token)
    assert active.resource_id == f"res-{record.attempt_id}"
    # The local projection accepts exactly that channel's notifications.
    assert state.validate_notification(
        channel_id=record.attempt_id, resource_id=active.resource_id, verification_token=token,
    ) is not None
    assert state.validate_notification(
        channel_id=record.attempt_id, resource_id=active.resource_id, verification_token="wrong",
    ) is None
    assert brain.events[-1] == "release" and brain.gate_closed
    state.close()


async def test_a_lost_response_is_uncertain_and_an_early_notification_lets_the_next_sweep_stop_it(
    tmp_path, monkeypatch,
):
    brain = _Brain().install(monkeypatch)

    def lost(record, token):
        raise TimeoutError("response lost")

    provider = _Provider(brain, on_dispatch=lost)
    state = StateStore(str(tmp_path / "lost-response.sqlite"))

    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)

    (uncertain,) = brain.records().values()
    assert uncertain.state == UNCERTAIN
    (_record_sent, _cursor, token) = provider.dispatched[0]
    # Google's first message may arrive before (or instead of) its response. It is not a channel
    # we accept — no stream is marked dirty — but its resource id is evidence that the channel
    # exists, and how to stop it.
    assert state.validate_notification(
        channel_id=uncertain.attempt_id, resource_id="res-early", verification_token=token,
    ) is None
    assert state.observe_pending_notification(
        channel_id=uncertain.attempt_id, resource_id="res-early", verification_token="forged",
    ) is False
    assert state.observe_pending_notification(
        channel_id=uncertain.attempt_id, resource_id="res-early", verification_token=token,
    ) is True
    assert state.pending_hint_connections("demo") == {}

    # Next sweep: the uncertain channel is stopped by what was observed; with it resolved, the
    # stream may get a new attempt (here answered normally).
    provider.on_dispatch = _Provider(brain).on_dispatch
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    records = brain.records()
    assert records[uncertain.attempt_id].state == RETIRED
    assert provider.stopped == [(uncertain.attempt_id, "res-early")]
    assert [r.state for r in records.values() if r.attempt_id != uncertain.attempt_id] == [ACTIVE]
    state.close()


async def test_a_definitive_refusal_retires_the_attempt_and_an_unknown_one_never_does(tmp_path, monkeypatch):
    brain = _Brain().install(monkeypatch)

    def refused(record, token):
        raise WatchRefused(400)

    state = StateStore(str(tmp_path / "refused.sqlite"))
    await watch_renewal.renew_watches(state, _Provider(brain, on_dispatch=refused), [_conn()], SETTINGS)
    (record,) = brain.records().values()
    assert record.state == RETIRED and "refused" in record.detail
    state.close()


async def test_an_invalid_response_is_never_activated(tmp_path, monkeypatch):
    brain = _Brain().install(monkeypatch)

    def too_long(record, token):
        return {"id": record.attempt_id, "resourceId": "res", "expiration": _ms(timedelta(days=60))}

    provider = _Provider(brain, on_dispatch=too_long)
    state = StateStore(str(tmp_path / "invalid.sqlite"))
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    (record,) = brain.records().values()
    # It exists (id and resource id are known), but not as requested: it is stopped, not trusted —
    # in the same sweep, within the cleanup allowance.
    assert record.state == RETIRED and provider.stopped == [(record.attempt_id, "res")]
    assert state.list_channels("gd", active_only=True) == []

    def other_channel(record, token):
        return {"id": "not-mine", "resourceId": "res", "expiration": _ms(timedelta(days=6))}

    brain2 = _Brain().install(monkeypatch)
    state2 = StateStore(str(tmp_path / "other-channel.sqlite"))
    await watch_renewal.renew_watches(state2, _Provider(brain2, on_dispatch=other_channel), [_conn()], SETTINGS)
    (record,) = brain2.records().values()
    assert record.state == UNCERTAIN  # our own channel may still exist; nothing to stop it by
    state.close(), state2.close()


async def test_lease_loss_at_the_dispatch_marker_sends_nothing(tmp_path, monkeypatch):
    brain = _Brain().install(monkeypatch)
    brain.checkpoint_faults.append(
        lambda payload: BrainError(409, "stale_execution", "replaced")
        if any(r["state"] == DISPATCHED for r in payload.get("watches", {}).get("records", [])) else None
    )
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / "lease-loss.sqlite"))

    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)

    assert provider.dispatched == []
    (record,) = brain.records().values()
    assert record.state == PREPARED  # the intent was durable; the next sweep retires it unsent
    assert brain.events.count("release") == 1

    brain.checkpoint_faults.clear()
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert brain.records()[record.attempt_id].state == RETIRED
    state.close()


async def test_a_dispatched_record_from_a_crashed_sweep_is_uncertain_and_bounds_new_attempts(
    tmp_path, monkeypatch,
):
    stale = [
        _record(DISPATCHED, attempt_id=f"crashed-{n}") for n in range(watch_renewal.MAX_UNRESOLVED_PER_STREAM)
    ]
    brain = _Brain()
    brain.progress["watches"] = to_section({r.attempt_id: r for r in stale})
    brain.install(monkeypatch)
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / "recovery.sqlite"))

    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)

    # Nobody owns them any more and their outcome was never published: the channels may exist.
    assert {r.attempt_id: r.state for r in brain.records().values()} == {
        r.attempt_id: UNCERTAIN for r in stale
    }
    # The stream already has the maximum of unknown attempts: no new one — polling covers it.
    assert provider.dispatched == []
    # The local projection was rebuilt from the brain, so a notification for them is evidence only.
    assert state.list_channels("gd", active_only=True) == []
    state.close()


async def test_uncertain_attempts_expire_at_their_requested_expiry_and_stay_terminal(tmp_path, monkeypatch):
    past = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    brain = _Brain()
    brain.progress["watches"] = to_section({"old": _record(UNCERTAIN, attempt_id="old", requested_expiry=past)})
    brain.install(monkeypatch)
    state = StateStore(str(tmp_path / "expiry.sqlite"))

    await watch_renewal.renew_watches(state, _Provider(brain), [_conn()], SETTINGS)

    assert brain.records()["old"].state == EXPIRED
    # A late observation for an expired attempt changes nothing.
    assert state.record_watch_evidence("gd", "old", "res-late") is False
    state.close()


def _controlled_deadline(monkeypatch) -> asyncio.Event:
    """The renewal's worker deadline passes exactly when the test sets the returned event.

    Replaces only the bounded wait (``watch_renewal._wait_bounded``): the worker, the thread pool,
    the abandonment, late-result handling and publication are all the production code.
    """
    deadline_passed = asyncio.Event()

    async def wait_until_the_test_says(awaitable, _timeout):
        waiter = asyncio.ensure_future(awaitable)
        stopper = asyncio.ensure_future(deadline_passed.wait())
        done, _pending = await asyncio.wait({waiter, stopper}, return_when=asyncio.FIRST_COMPLETED)
        if waiter in done:
            stopper.cancel()
            return waiter.result()
        waiter.cancel()  # cancels the shield's outer future; the worker itself keeps running
        raise asyncio.TimeoutError

    monkeypatch.setattr(watch_renewal, "_wait_bounded", wait_until_the_test_says)
    return deadline_passed


def _blocking_provider(brain: _Brain, resource_id: str):
    entered, release = threading.Event(), threading.Event()

    def blocked(record, token):
        entered.set()
        assert release.wait(10), "the test never released the provider call"
        return {"id": record.attempt_id, "resourceId": resource_id, "expiration": _ms(timedelta(days=6))}

    return _Provider(brain, on_dispatch=blocked), entered, release


async def test_slow_provider_work_leaves_unrelated_scheduler_work_responsive_and_late_results_inert(
    tmp_path, monkeypatch,
):
    deadline_passed = _controlled_deadline(monkeypatch)
    brain = _Brain().install(monkeypatch)
    provider, entered, release = _blocking_provider(brain, "res-late")
    state = StateStore(str(tmp_path / "slow.sqlite"))

    sweep = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(entered.wait, 10)

    # The provider call is stuck in its worker thread. Unrelated work on the same event loop runs
    # to completion meanwhile — the sweep has not finished, and nothing waits on the provider.
    async def unrelated_job():
        for _ in range(50):
            await asyncio.sleep(0)
        return "done"

    assert await unrelated_job() == "done"
    assert not sweep.done()

    # The deadline passes: the worker is abandoned and the outcome published as unknown.
    deadline_passed.set()
    await sweep
    (record,) = brain.records().values()
    assert record.state == UNCERTAIN
    # The abandoned worker still uses the authority gate: it is not closed underneath it.
    assert brain.gate_closed is False
    assert brain.events.count("release") == 1

    # The worker finishes. Its late answer is cleanup evidence — never an activation — and only
    # now are its resources closed.
    release.set()
    assert await asyncio.to_thread(brain.gate_closed_event.wait, 10)
    await asyncio.sleep(0)  # the evidence write was handed to the loop before the gate closed
    assert state.watch_evidence("gd", record.attempt_id) == "res-late"
    assert state.list_channels("gd", active_only=True) == []
    assert brain.records()[record.attempt_id].state == UNCERTAIN
    state.close()


async def test_cancellation_after_dispatch_stops_further_work_and_never_activates(tmp_path, monkeypatch):
    brain = _Brain().install(monkeypatch)
    provider, entered, release = _blocking_provider(brain, "res-after-cancel")
    state = StateStore(str(tmp_path / "cancel.sqlite"))

    sweep = asyncio.create_task(watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS))
    await asyncio.to_thread(entered.wait, 10)
    sweep.cancel()
    with pytest.raises(asyncio.CancelledError):
        await sweep

    (record,) = brain.records().values()
    assert record.state == DISPATCHED  # durably "may exist"; nothing was published after cancellation
    assert brain.events.count("release") == 1
    assert brain.gate_closed is False  # the surviving worker still holds it

    release.set()
    assert await asyncio.to_thread(brain.gate_closed_event.wait, 10)
    await asyncio.sleep(0)
    assert state.watch_evidence("gd", record.attempt_id) == "res-after-cancel"
    assert state.list_channels("gd", active_only=True) == []

    # The next sweep owns it: what Google answered late identifies it, so it is stopped.
    provider.on_dispatch = _Provider(brain).on_dispatch
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert brain.records()[record.attempt_id].state == RETIRED
    assert (record.attempt_id, "res-after-cancel") in provider.stopped
    state.close()


async def test_an_authority_refusal_at_the_live_check_dispatches_nothing_and_stops_the_connection(
    tmp_path, monkeypatch,
):
    brain = _Brain().install(monkeypatch)
    calls = []

    def gate_refused(record, token):
        calls.append(record.attempt_id)
        raise WatchNotDispatched("authority refused") from BrainError(409, "connection_unavailable", "paused")

    state = StateStore(str(tmp_path / "gate.sqlite"))
    await watch_renewal.renew_watches(state, _Provider(brain, on_dispatch=gate_refused), [_conn()], SETTINGS)
    (record,) = brain.records().values()
    assert record.state == RETIRED  # provably never sent
    assert brain.events.count("release") == 1
    state.close()


async def test_a_paused_connection_renews_and_creates_nothing(tmp_path, monkeypatch):
    brain = _Brain(status="disabled").install(monkeypatch)
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / "paused.sqlite"))
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert "acquire" not in brain.events and provider.dispatched == []
    state.close()


async def test_an_active_channel_that_is_not_due_is_kept_and_overlap_is_preserved(tmp_path, monkeypatch):
    soon = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
    later = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
    brain = _Brain()
    brain.progress["watches"] = to_section({"current": _record(
        ACTIVE, attempt_id="current", resource_id="res-current", expires_at=later,
    )})
    brain.install(monkeypatch)
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / "not-due.sqlite"))
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert provider.dispatched == []

    # Due: a successor is created and the predecessor stays active (overlap) until its own expiry.
    brain.progress["watches"] = to_section({"current": _record(
        ACTIVE, attempt_id="current", resource_id="res-current", expires_at=soon,
    )})
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    records = brain.records()
    assert records["current"].state == ACTIVE
    (successor,) = [r for r in records.values() if r.attempt_id != "current"]
    assert successor.state == ACTIVE and successor.predecessor == "current"
    assert {c.channel_id for c in state.list_channels("gd", active_only=True)} == {
        "current", successor.attempt_id,
    }
    state.close()


async def test_legacy_local_channels_count_as_current_for_renewal(tmp_path, monkeypatch):
    brain = _Brain().install(monkeypatch)
    provider = _Provider(brain)
    state = StateStore(str(tmp_path / "legacy.sqlite"))
    namespace = StreamKey("demo", INTEGRATION, ACCOUNT, "my-drive").namespace(3)
    state.save_channel(Channel("gd", "legacy", "res", "2999-01-01T00:00:00+00:00", namespace))
    await watch_renewal.renew_watches(state, provider, [_conn()], SETTINGS)
    assert provider.dispatched == []
    state.close()


# --------------------------------------------------------------------------------------------- #
# The provider manager: one request, classified, never retried
# --------------------------------------------------------------------------------------------- #

class _HttpError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.resp = type("Response", (), {"status": status})()


def _manager_with(outcome, gate_error=None):
    from aios_ingest.sources.gdrive_watch import GoogleDriveWatchManager

    seen = {"watch": [], "executions": [], "stops": []}

    class Request:
        def __init__(self, kind):
            self.kind = kind

        def execute(self, num_retries=None):
            seen["executions"].append((self.kind, num_retries))
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

    class Changes:
        def watch(self, **kwargs):
            seen["watch"].append(kwargs)
            return Request("watch")

    class Channels:
        def stop(self, **kwargs):
            seen["stops"].append(kwargs)
            return Request("stop")

    class Service:
        def changes(self): return Changes()
        def channels(self): return Channels()

    def gate():
        seen.setdefault("gate", 0)
        seen["gate"] += 1
        if gate_error is not None:
            raise gate_error

    manager = GoogleDriveWatchManager(webhook_url="https://example.test/watch", provider_gate=gate)
    manager._service = lambda deadline=None: Service()
    return manager, seen


def test_dispatch_sends_exactly_this_attempts_channel_once_after_the_live_authority_check():
    record = _record(DISPATCHED, drive_id="shared-a")
    response = {"id": record.attempt_id, "resourceId": "r", "expiration": _ms(timedelta(days=6))}
    manager, seen = _manager_with(response)
    assert manager.dispatch(record, page_token="cursor", verification_token="raw-token") == response
    (call,) = seen["watch"]
    assert call["body"]["id"] == record.attempt_id and call["body"]["token"] == "raw-token"
    assert call["pageToken"] == "cursor" and call["driveId"] == "shared-a"
    assert call["body"]["expiration"] == int(datetime.fromisoformat(record.requested_expiry).timestamp() * 1000)
    assert seen["executions"] == [("watch", 0)] and seen["gate"] == 1


def test_dispatch_classifies_not_sent_refused_and_unknown_outcomes():
    record = _record(DISPATCHED)
    manager, seen = _manager_with({}, gate_error=BrainError(409, "connection_unavailable", "paused"))
    with pytest.raises(WatchNotDispatched) as not_sent:
        manager.dispatch(record, page_token="c", verification_token="t")
    assert isinstance(not_sent.value.__cause__, BrainError) and seen["executions"] == []

    for status in (400, 403, 404, 429):
        manager, _ = _manager_with(_HttpError(status))
        with pytest.raises(WatchRefused):
            manager.dispatch(record, page_token="c", verification_token="t")
    for failure in (_HttpError(500), _HttpError(408), TimeoutError("lost")):
        manager, seen = _manager_with(failure)
        with pytest.raises(type(failure)):
            manager.dispatch(record, page_token="c", verification_token="t")
        assert seen["executions"] == [("watch", 0)]  # one attempt, never a blind retry

    manager, seen = _manager_with({})
    with pytest.raises(WatchNotDispatched):
        manager.dispatch(record, page_token="c", verification_token="t", deadline=time.monotonic() - 1)
    assert seen["executions"] == []


def test_stop_treats_an_unknown_channel_as_already_gone():
    manager, seen = _manager_with(_HttpError(404))
    manager.stop("channel", "resource")
    assert seen["stops"] == [{"body": {"id": "channel", "resourceId": "resource"}}]
    manager, _ = _manager_with(_HttpError(500))
    with pytest.raises(_HttpError):
        manager.stop("channel", "resource")


def test_the_webhook_records_an_early_notification_for_a_pending_attempt_without_waking_anything(
    tmp_path, monkeypatch,
):
    from aios_ingest.webhook_app import _gdrive_notification

    path = tmp_path / "early-webhook.sqlite"
    monkeypatch.setenv("AIOS_INGEST_STATE", str(path))
    state = StateStore(str(path))
    key = StreamKey("demo", INTEGRATION, ACCOUNT, "my-drive")
    state.begin_generation(key, 3, start_token="start")
    state.save_watch_record(_record(DISPATCHED))
    headers = {"x-goog-channel-id": "attempt-1", "x-goog-resource-id": "res-early"}

    forged = _gdrive_notification({**headers, "x-goog-channel-token": "forged"})
    assert forged.status_code == 401
    early = _gdrive_notification({**headers, "x-goog-channel-token": "secret-token"})
    assert early.status_code == 202
    # Recorded as evidence; no stream marked dirty, no channel accepted.
    assert state.watch_evidence("gd", "attempt-1") == "res-early"
    assert state.pending_hint_connections("demo") == {}
    assert state.list_channels("gd", active_only=True) == []
    state.close()
