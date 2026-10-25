"""Bounded, cancellable Drive watch renewal under the execution fence (AIO-1167 R41, AC-04/AC-07).

The scheduler's renewal sweep calls :func:`renew_watches`. For every enabled Drive connection it
acquires the same execution authority as polling, then:

1. **Recovers** what earlier sweeps left: an intent never marked dispatched is retired (nothing was
   sent); a ``dispatched`` record nobody owns any more is ``uncertain``; an uncertain attempt with a
   resource id observed for it (an early notification, a late response) becomes ``cleanup_pending``;
   anything past the bound of its life is ``expired``.
2. **Creates** a channel for each stream whose newest active channel is missing or due — at most a
   bounded number per sweep, never while a stream already has the maximum of unresolved attempts
   (polling covers it meanwhile), and always: durable ``prepared`` intent → fenced ``dispatched``
   marker → ONE provider request in a worker thread → validated, fenced ``active``.
3. **Cleans up** known channels that must be stopped, within a reserved allowance.

Every lifecycle change is published to the brain under the fence via the renewal-owned ``watches``
section (``connector_state.renewal_document``): renewal can never touch a cursor, and a stale
renewal can publish nothing. The local ``webhook_channels`` rows are written only after a
publication the brain acknowledged — they are a projection, rebuilt from the brain at the start of
every sweep.

Blocking work — client construction, credential refresh, the live authority check, the provider
call — runs in a small pool OWNED by this module, under one absolute run deadline, so the event loop
and every other scheduler job stay responsive. SQLite is touched only from the event loop. A worker
that is still running when its deadline passes cannot be stopped; it is abandoned, not trusted: its
result can only ever add cleanup evidence for its attempt (never activation), and the resources it
uses are closed only once it has finished.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
import secrets
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from . import brain_client
from .brain_client import BrainClient, BrainError
from .config import BrainSettings, Connection
from .connector_state import renewal_document
from .gdrive_sync import credential_identity
from .selections import effective_gdrive_connection
from .state import StateStore, StreamKey, verification_hash
from .watch_lifecycle import (
    ACTIVE, CLEANUP_PENDING, DISPATCHED, EXPIRED, PENDING_STATES, PREPARED, RETIRED, UNCERTAIN,
    InvalidWatchResponse, WatchNotDispatched, WatchRecord, WatchRefused, from_section, now_iso,
    parse_instant, requested_expiry, to_section, transition, validate_watch_response,
)

log = logging.getLogger(__name__)

# One connection's whole renewal — authority, broker, recovery, creation, cleanup and every
# checkpoint delivery — fits in this absolute budget.
WATCH_RUN_SECONDS = 60.0
# The last part of that budget is reserved for stopping known channels.
WATCH_CLEANUP_SECONDS = 10.0
# Creations and stops a single sweep may start, across all connections.
MAX_CREATES_PER_SWEEP = 4
MAX_STOPS_PER_SWEEP = 2
# A stream with this many attempts whose outcome is unknown gets no new one until they resolve.
MAX_UNRESOLVED_PER_STREAM = 2
# Stop attempts per channel; afterwards it is left to expire at the bound of its life.
MAX_STOP_ATTEMPTS = 5
RENEWAL_SKEW_SECONDS = 600

_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gdrive-watch")


async def _wait_bounded(awaitable: Any, timeout: float) -> Any:
    """Wait for a worker's result for at most ``timeout`` seconds (``asyncio.TimeoutError`` after).

    The one place a blocking step's deadline is enforced — a seam, so tests decide exactly when
    the deadline passes instead of racing a wall clock.
    """
    return await asyncio.wait_for(awaitable, timeout=timeout)


class WatchStepTimeout(Exception):
    """A blocking step outlived the run deadline. ``started``: whether it ever began."""

    def __init__(self, started: bool):
        super().__init__("watch step deadline exceeded")
        self.started = started


@dataclass
class _Budget:
    creates: int = MAX_CREATES_PER_SWEEP
    stops: int = MAX_STOPS_PER_SWEEP


@dataclass
class _Run:
    """One connection's renewal: its deadline, its fenced publication and its workers."""

    client: BrainClient
    execution: Any
    state: StateStore
    team: str
    deadline: float
    records: dict[str, WatchRecord]
    running: list[Future] = field(default_factory=list)

    def remaining(self) -> float:
        return self.deadline - time.monotonic()

    async def bounded(self, awaitable: Any) -> Any:
        remaining = self.remaining()
        if remaining <= 0:
            if asyncio.iscoroutine(awaitable):
                awaitable.close()
            raise WatchStepTimeout(started=False)
        try:
            return await asyncio.wait_for(awaitable, timeout=remaining)
        except asyncio.TimeoutError:
            raise WatchStepTimeout(started=True) from None

    async def offload(
        self, fn: Callable[[], Any], *, on_late: Callable[[Future], None] | None = None,
        deadline: float | None = None,
    ) -> Any:
        """Run one blocking step in the owned pool, bounded by ``deadline`` (default: the run's).

        A step that never started is cancelled outright — nothing was done. A step already running
        cannot be interrupted: it is abandoned, its outcome handed to ``on_late`` (from its own
        thread) and its resources kept open until it ends. Cancellation of this coroutine is never
        swallowed.
        """
        remaining = (deadline if deadline is not None else self.deadline) - time.monotonic()
        if remaining <= 0:
            raise WatchStepTimeout(started=False)
        future = _POOL.submit(fn)
        self.running.append(future)
        future.add_done_callback(lambda done: self.running.remove(done) if done in self.running else None)
        try:
            return await _wait_bounded(asyncio.shield(asyncio.wrap_future(future)), remaining)
        except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
            started = not future.cancel()
            if started and on_late is not None:
                future.add_done_callback(on_late)
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise WatchStepTimeout(started=started) from None

    async def publish(self, *changed: WatchRecord) -> None:
        """Publish lifecycle changes under the fence, then project them locally.

        Raises when the brain refuses (stale authority) or cannot be reached in time: nothing is
        projected then, and the next sweep starts again from what the brain holds.
        """
        updated = dict(self.records)
        for record in changed:
            updated[record.attempt_id] = record
        document = renewal_document(self.execution.progress, to_section(updated))
        ack = await self.bounded(self.client.checkpoint_gdrive_execution(self.execution, document)) or {}
        acknowledged = dict(ack.get("progress") or document)
        self.execution.progress.clear()
        self.execution.progress.update(acknowledged)
        self.records = updated
        for record in changed:
            self.state.save_watch_record(record)


def _close_when_idle(run: _Run | None, closers: list[Callable[[], None]]) -> None:
    """Close shared resources now, or once the last abandoned worker using them has finished."""
    pending = [future for future in (run.running if run else []) if not future.done()]
    lock = threading.Lock()
    closed = [False]

    def close_all(*_args: Any) -> None:
        if any(not future.done() for future in pending):
            return
        with lock:
            if closed[0]:
                return
            closed[0] = True
        for close in closers:
            try:
                close()
            except Exception:
                pass

    if not pending:
        close_all()
        return
    for future in pending:
        future.add_done_callback(close_all)


def _late_evidence(
    loop: asyncio.AbstractEventLoop, state: StateStore, record: WatchRecord,
) -> Callable[[Future], None]:
    """What an abandoned creation worker's eventual result may do: record cleanup evidence.

    It runs in the worker's thread, so the SQLite write is handed back to the event loop. A late
    response can show that a channel exists (and how to stop it); it can never activate one.
    """
    def deliver(future: Future) -> None:
        if future.cancelled() or future.exception() is not None:
            return
        response = future.result()
        resource_id = response.get("resourceId") if isinstance(response, dict) else None
        if not isinstance(resource_id, str) or not resource_id:
            return
        try:
            loop.call_soon_threadsafe(
                state.record_watch_evidence, record.connection, record.attempt_id, resource_id,
            )
        except RuntimeError:  # the loop is gone; the record stays uncertain until its expiry
            pass
    return deliver


def _past(instant: str | None, now: datetime) -> bool:
    parsed = parse_instant(instant)
    return parsed is not None and parsed <= now


async def _recover(run: _Run, connection: str, now: datetime) -> None:
    changed: list[WatchRecord] = []
    for record in sorted(run.records.values(), key=lambda r: r.attempt_id):
        if record.connection != connection or record.terminal:
            continue
        if record.state == PREPARED:
            # Never marked dispatched under the fence, so it was never sent.
            changed.append(transition(record, RETIRED, detail="intent abandoned before dispatch"))
        elif record.state == DISPATCHED:
            # This sweep holds the lease, so the worker that dispatched it is gone without a
            # published outcome: the channel may exist — and if Google has already named its
            # resource (early notification, late response), it does, and is stopped.
            evidence = run.state.watch_evidence(record.connection, record.attempt_id)
            if evidence:
                changed.append(transition(
                    record, CLEANUP_PENDING, resource_id=evidence,
                    detail="observed after its outcome was lost; stopping",
                ))
            else:
                changed.append(transition(record, UNCERTAIN, detail="dispatch outcome lost"))
        elif record.state == UNCERTAIN:
            evidence = run.state.watch_evidence(record.connection, record.attempt_id)
            if evidence:
                changed.append(transition(
                    record, CLEANUP_PENDING, resource_id=evidence,
                    detail="observed after an unknown outcome; stopping",
                ))
            elif _past(record.requested_expiry, now):
                changed.append(transition(record, EXPIRED, detail="past its requested expiry"))
        elif record.state in (ACTIVE, CLEANUP_PENDING) and _past(record.life_bound(), now):
            changed.append(transition(record, EXPIRED, detail="past its expiry"))
    if changed:
        await run.publish(*changed)


def _streams(execution: Any) -> list[tuple[str, str]]:
    """``(drive_id, cursor)`` for every stream the brain's checkpoint holds. Read, never written."""
    progress = execution.progress
    stream_map = progress.get("streams")
    if isinstance(stream_map, dict):
        streams = [(str(drive), dict(stream)) for drive, stream in stream_map.items() if isinstance(stream, dict)]
    else:
        streams = [(str(progress.get("drive_id") or ""), dict(progress))]
    return [
        (drive, str(stream.get("page_token") or stream.get("baseline_start_token") or ""))
        for drive, stream in streams
        if drive and (stream.get("page_token") or stream.get("baseline_start_token"))
    ]


def _publish_reserve() -> float:
    """Time kept back from a provider call to publish its outcome under the fence."""
    return min(5.0, WATCH_RUN_SECONDS * 0.25)


def _due(expires_at: str | None, now: datetime) -> bool:
    parsed = parse_instant(expires_at)
    return parsed is None or (parsed - now).total_seconds() <= RENEWAL_SKEW_SECONDS


async def _create(
    run: _Run, manager: Any, conn: Connection, *, account_id: str, drive_id: str, cursor: str,
    namespace: str, predecessor: str | None, access_token: str | None, provider_gate: Any,
    ttl_seconds: int,
) -> None:
    token = secrets.token_urlsafe(32)
    intent = WatchRecord(
        attempt_id=str(uuid.uuid4()), connection=conn.name,
        integration_id=run.execution.integration_id, account_id=account_id, drive_id=drive_id,
        generation=int(run.execution.generation), namespace=namespace,
        verification_hash=verification_hash(token), requested_expiry=requested_expiry(ttl_seconds),
        predecessor=predecessor, state=PREPARED,
    )
    # 1. The intent is durable before anything else happens.
    await run.publish(intent)
    # 2. The dispatch marker: a fenced write, so a paused, replaced or revoked execution stops here,
    #    and a record that from now on says a channel MAY exist.
    dispatched = transition(intent, DISPATCHED)
    await run.publish(dispatched)
    loop = asyncio.get_running_loop()
    # The provider call ends early enough that its outcome — whatever it is — can still be
    # published inside the run deadline.
    dispatch_deadline = run.deadline - _publish_reserve()
    try:
        response = await run.offload(
            lambda: manager.dispatch(
                dispatched, page_token=cursor, verification_token=token,
                access_token=access_token, provider_gate=provider_gate, deadline=dispatch_deadline,
            ),
            on_late=_late_evidence(loop, run.state, dispatched),
            deadline=dispatch_deadline,
        )
    except asyncio.CancelledError:
        # Further dispatch stops. The durable ``dispatched`` record is recovered as uncertain by
        # the next sweep; a late response can only become cleanup evidence.
        raise
    except WatchStepTimeout as timeout:
        if not timeout.started:
            await run.publish(transition(dispatched, RETIRED, detail="deadline reached before dispatch"))
        else:
            await run.publish(transition(dispatched, UNCERTAIN, detail="no response before the run deadline"))
        return
    except WatchNotDispatched as exc:
        await run.publish(transition(dispatched, RETIRED, detail=str(exc)))
        if isinstance(exc.__cause__, BrainError):
            raise exc.__cause__  # the live authority check refused: nothing more for this connection
        return
    except WatchRefused as exc:
        await run.publish(transition(dispatched, RETIRED, detail=f"provider refused ({exc.status})"))
        return
    except Exception as exc:
        await run.publish(transition(dispatched, UNCERTAIN, detail=f"outcome unknown: {type(exc).__name__}"))
        return
    try:
        resource_id, expires_at = validate_watch_response(dispatched, response)
    except InvalidWatchResponse as exc:
        if exc.resource_id and str((response or {}).get("id") or "") == dispatched.attempt_id:
            await run.publish(transition(
                dispatched, CLEANUP_PENDING, resource_id=exc.resource_id, detail=exc.reason,
            ))
        else:
            await run.publish(transition(dispatched, UNCERTAIN, detail=exc.reason))
        return
    active = transition(dispatched, ACTIVE, resource_id=resource_id, expires_at=expires_at, detail=None)
    try:
        await run.publish(active)
    except BaseException:
        # Created at Google, but the activation could not be published: keep what proves it
        # exists, so the sweep that next owns the record stops it instead of trusting it.
        run.state.record_watch_evidence(conn.name, dispatched.attempt_id, resource_id)
        raise


async def _cleanup(
    run: _Run, manager: Any, connection: str, budget: _Budget, *, access_token: str | None,
    provider_gate: Any,
) -> None:
    for record in sorted(run.records.values(), key=lambda r: r.attempt_id):
        if record.connection != connection or record.state != CLEANUP_PENDING or not record.resource_id:
            continue
        if budget.stops <= 0 or record.stop_attempts >= MAX_STOP_ATTEMPTS or run.remaining() <= 0:
            return
        budget.stops -= 1
        try:
            await run.offload(lambda r=record: manager.stop(
                r, str(r.resource_id), access_token=access_token, provider_gate=provider_gate,
                deadline=run.deadline,
            ))
        except asyncio.CancelledError:
            raise
        except BrainError:
            raise
        except Exception as exc:
            await run.publish(_bump_stop(record, f"stop failed: {type(exc).__name__}"))
            continue
        await run.publish(transition(record, RETIRED, detail="stopped"))


def _bump_stop(record: WatchRecord, detail: str) -> WatchRecord:
    """A failed stop is not a transition: the record stays cleanup_pending with one more attempt."""
    return dataclasses.replace(
        record, stop_attempts=record.stop_attempts + 1, detail=detail[:200], updated_at=now_iso(),
    )


async def _renew_connection(
    settings: BrainSettings, conn: Connection, row: dict[str, Any], state: StateStore, manager: Any,
    budget: _Budget, now: datetime,
) -> None:
    run: _Run | None = None
    closers: list[Callable[[], None]] = []
    execution = None
    client_cm = brain_client.BrainClient(settings.base_url, settings.api_key, settings.team)
    deadline = time.monotonic() + WATCH_RUN_SECONDS
    try:
        async with client_cm as client:
            acquire = client.acquire_gdrive_execution(str(row["id"]), str(uuid.uuid4()))
            remaining = deadline - time.monotonic()
            execution = await asyncio.wait_for(acquire, timeout=max(0.1, remaining))
            run = _Run(client, execution, state, settings.team, deadline, from_section(execution.progress))
            effective = effective_gdrive_connection(conn, execution.config, execution.integration_id)
            account_id = str(
                execution.config.get("authenticatedAccountId")
                or execution.config.get("authenticatedAccount")
                or credential_identity(effective.options)
            )
            access_token = None
            auth_mode = str(effective.options.get("auth_mode") or "oauth")
            if auth_mode == "oauth":
                grant = await run.bounded(client.broker_gdrive_access_token(execution))
                access_token = grant["access_token"]
            elif not (effective.options.get("service_account_key_path") or effective.options.get("credential_json")):
                return
            provider_gate = client.gdrive_provider_gate(execution)
            closers.append(provider_gate.close)
            # The local projection is rebuilt from the brain's record — what a lost or stale local
            # state lacks is restored before any decision is made.
            for record in run.records.values():
                if record.connection == conn.name:
                    state.save_watch_record(record)
            await _recover(run, conn.name, now)
            await _create_where_due(
                run, manager, conn, budget, now, account_id=account_id,
                access_token=access_token, provider_gate=provider_gate,
            )
            await _cleanup(
                run, manager, conn.name, budget, access_token=access_token,
                provider_gate=provider_gate,
            )
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        # Fail closed: valid old channels stay active and polling remains the backstop.
        log.warning("Drive watch renewal for %s stopped: %s", conn.name, type(exc).__name__)
    finally:
        # Workers never publish, so releasing the lease cannot let an abandoned one activate
        # anything; the resources they use are closed only when they have all finished.
        _close_when_idle(run, closers)
        if execution is not None:
            try:
                async with brain_client.BrainClient(settings.base_url, settings.api_key, settings.team) as releaser:
                    await asyncio.wait_for(releaser.release_gdrive_execution(execution), timeout=10.0)
            except Exception:
                pass


async def _create_where_due(
    run: _Run, manager: Any, conn: Connection, budget: _Budget, now: datetime, *,
    account_id: str, access_token: str | None, provider_gate: Any,
) -> None:
    ttl = int(getattr(manager, "ttl_seconds", lambda _name: 604_800)(conn.name))
    for drive_id, cursor in _streams(run.execution):
        # A creation starts only if its outcome can be published and the cleanup allowance kept.
        if budget.creates <= 0 or run.remaining() <= WATCH_CLEANUP_SECONDS + _publish_reserve():
            return
        namespace = StreamKey(
            run.team, run.execution.integration_id, account_id, drive_id,
        ).namespace(run.execution.generation)
        mine = [r for r in run.records.values() if r.connection == conn.name and r.namespace == namespace]
        if sum(1 for r in mine if r.state in PENDING_STATES) >= MAX_UNRESOLVED_PER_STREAM:
            continue  # polling covers this stream until its unknown attempts resolve
        active = sorted((r for r in mine if r.state == ACTIVE), key=lambda r: r.expires_at or "")
        legacy = sorted(
            (c for c in run.state.list_channels(conn.name, active_only=True)
             if c.namespace == namespace and c.channel_id not in run.records),
            key=lambda c: c.expires_at or "",
        )
        newest_expiry = max(
            [r.expires_at for r in active if r.expires_at] + [c.expires_at for c in legacy if c.expires_at],
            default=None,
        )
        if active or legacy:
            if not _due(newest_expiry, now):
                continue
        predecessor = (active[-1].attempt_id if active else (legacy[-1].channel_id if legacy else None))
        budget.creates -= 1
        await _create(
            run, manager, conn, account_id=account_id, drive_id=drive_id, cursor=cursor,
            namespace=namespace, predecessor=predecessor, access_token=access_token,
            provider_gate=provider_gate, ttl_seconds=ttl,
        )


async def renew_watches(
    state: StateStore, manager: Any, connections: list[Connection], settings: BrainSettings,
) -> None:
    """One renewal sweep over every enabled Drive connection. Admin state is re-read first."""
    try:
        async with brain_client.BrainClient(settings.base_url, settings.api_key, settings.team) as discovery:
            remote = await asyncio.wait_for(
                discovery.fetch_integration_selections(include_disabled=True), timeout=WATCH_RUN_SECONDS,
            )
    except asyncio.CancelledError:
        raise
    except Exception:
        return  # unknown Admin state: renew nothing
    enabled = {
        str(row.get("name")): row for row in remote
        if row.get("type") == "gdrive" and row.get("status") == "enabled" and row.get("id")
    }
    budget = _Budget()
    now = datetime.now(timezone.utc)
    for conn in (candidate for candidate in connections if candidate.source == "gdrive"):
        row = enabled.get(conn.name)
        if row is None:
            continue
        await _renew_connection(settings, conn, row, state, manager, budget, now)
