"""Scheduled polling + Drive watch-channel renewal.

APScheduler runs each connection's incremental poll on an interval (sha256 dedup at the
brain makes re-polls cheap no-ops), and a periodic sweep renews Google Drive watch
channels before they expire. The renewal *selection* (``due_for_renewal``) is pure and
unit-tested; the actual Drive API call lives behind a pluggable WatchManager.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Protocol

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .config import BrainSettings, Connection
from .engine import run_connection
from .state import Channel, StateStore
from .gdrive_sync import run_gdrive_stream
from .selections import merge_selections

log = logging.getLogger(__name__)

# Renew a watch channel this many seconds before its stated expiry.
_RENEWAL_SKEW = 600


class WatchManager(Protocol):
    """Creates and stops Drive watch channels.

    The fenced scheduler path (``watch_renewal``) uses ``dispatch``/``stop`` — one bounded provider
    request per call, never retried, run in a worker thread. ``renew`` is the legacy local path for
    a scheduler built without brain settings.
    """

    def renew(self, channel: Channel, page_token: str | None = None,
              access_token: str | None = None, provider_gate=None,
              drive_id: str | None = None) -> Channel: ...


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def due_for_renewal(channels: list[Channel], now_iso: str, skew: int = _RENEWAL_SKEW) -> list[Channel]:
    """Channels whose expiry is within ``skew`` seconds of ``now`` (or already past).
    Channels without an expiry are treated as never-expiring and skipped."""
    now = _parse(now_iso)
    due: list[Channel] = []
    for ch in channels:
        if not ch.expires_at:
            continue
        if (_parse(ch.expires_at) - now).total_seconds() <= skew:
            due.append(ch)
    return due


def _parse(iso: str) -> datetime:
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def build_scheduler(
    settings: BrainSettings,
    connections: list[Connection],
    *,
    state: StateStore,
    poll_interval: int = 300,
    renewal_interval: int = 1800,
    watch_manager: WatchManager | None = None,
    bootstrap_remote_gdrive: bool = False,
) -> AsyncIOScheduler:
    """Register a poll job per connection (+ a renewal sweep if a WatchManager is given).
    Does not start the scheduler — caller starts it (see :func:`run`).

    ``bootstrap_remote_gdrive`` serves Admin-created OAuth Drive integrations that have no entry
    in the local connection list: their scheduled poll and their Run now/Retry queue are registered
    even when ``connections`` names no Drive connection at all."""
    sched = AsyncIOScheduler(timezone="UTC")

    for conn in connections:
        sched.add_job(
            _poll_job,
            "interval",
            seconds=poll_interval,
            id=f"poll:{conn.name}",
            args=[settings, conn, state],
            max_instances=1,
            coalesce=True,
        )

    if bootstrap_remote_gdrive or any(conn.source == "gdrive" for conn in connections):
        sched.add_job(
            _manual_gdrive_job,
            "interval",
            seconds=min(15, max(5, poll_interval)),
            id="gdrive-manual-queue",
            args=[settings, connections, state],
            max_instances=1,
            coalesce=True,
        )
        # Validated Drive notifications wake the same coordinator within seconds instead of waiting
        # for the poll interval. One run per connection per burst; the poll still repairs anything
        # a notification missed.
        sched.add_job(
            _gdrive_hint_job,
            "interval",
            seconds=min(15, max(5, poll_interval)),
            id="gdrive-notification-hints",
            args=[settings, connections, state, {}],
            max_instances=1,
            coalesce=True,
        )

    if bootstrap_remote_gdrive:
        sched.add_job(
            _remote_gdrive_poll_job,
            "interval",
            seconds=poll_interval,
            id="gdrive-remote-poll",
            args=[settings, connections, state],
            max_instances=1,
            coalesce=True,
        )

    if watch_manager is not None:
        sched.add_job(
            _renewal_job,
            "interval",
            seconds=renewal_interval,
            id="renewal-sweep",
            args=[state, watch_manager, connections, settings],
            max_instances=1,
            coalesce=True,
        )
    return sched


# Authority-loss categories a concurrent pause/disconnect can produce. Neither is suppressed on its
# own: each only triggers a re-read of the connection's current Admin state (see `_poll_job`).
_PAUSE_AUTHORITY_LOSS = frozenset({"connection_unavailable", "stale_execution"})
# The one category an unexpected coordinator exception is reported under. Fixed on purpose: the
# exception's text (a key-file path, a provider message) never leaves this process; its class name
# is logged locally for the operator.
_COORDINATOR_ERROR = "coordinator_error"
_REREAD_BEFORE_REPORTING = _PAUSE_AUTHORITY_LOSS | {_COORDINATOR_ERROR}


def _gdrive_exception_summary(conn: Connection, row: dict, exc: Exception):
    """A scheduled Drive run that RAISED (stream setup — e.g. a configured service-account key file
    that is missing — or any other unexpected coordinator error) as an ordinary failed summary, so
    it reaches the durable report, the attempt ledger and the banner like any other failure.

    The integration id is the one the preflight already resolved from Admin state for this exact
    connection — never invented: a row without an id yields none, and the run stays a local
    diagnostic. Nothing was acknowledged, so backlog stays unknown and no completion is claimed;
    the coordinator's own cleanup already released the lease and left progress and hints pending.
    """
    from .engine import IngestSummary
    log.warning("Drive poll for %s raised %s; reporting it as %s",
                conn.name, type(exc).__name__, _COORDINATOR_ERROR)
    return IngestSummary(
        conn.name, failed=1, failure_categories={_COORDINATOR_ERROR: 1},
        backlog=None, integration_id=str(row.get("id") or "") or None,
    )


async def _gdrive_admin_row(
    settings: BrainSettings, conn: Connection, integration_id: str | None = None,
) -> dict | None:
    """The Admin row this Drive connection runs as: by its immutable id — ``integration_id`` once the
    run has resolved it, else the one the configuration names — or, with neither, by name
    (documented local service-account configs). ``None`` when no row matches. A selection read
    failure raises: nothing runs on unknown Admin state."""
    from .brain_client import BrainClient
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        rows = await client.fetch_integration_selections(include_disabled=True)
    wanted_id = str(integration_id or conn.options.get("integration_id") or "")
    return next((
        row for row in rows
        if row.get("type") == "gdrive"
        and (str(row.get("id") or "") == wanted_id if wanted_id else row.get("name") == conn.name)
    ), None)


async def _poll_job(settings: BrainSettings, conn: Connection, state: StateStore) -> None:
    if conn.source == "gdrive":
        # PREFLIGHT (AIO-1167 r37): a paused or disconnected connection is not polled at all, so its
        # pause never becomes a failure report and a failure banner. The brain's execution fence
        # stays the authority for the race below; this only avoids asking it when the answer is known.
        row = await _gdrive_admin_row(settings, conn)
        if row is None:
            log.warning(
                "Drive connection %s matches no Admin integration; not polled and nothing reported",
                conn.name,
            )
            return
        if row.get("status") != "enabled":
            log.info("Drive connection %s is paused or disconnected; not polled", conn.name)
            return
        started = _now_iso()
        report_id = str(uuid.uuid4())
        try:
            summary = await run_gdrive_stream(settings, conn, state)
        except Exception as exc:  # never BaseException: cancellation and shutdown still propagate
            summary = _gdrive_exception_summary(conn, row, exc)
        integration_id = summary.integration_id or str(conn.options.get("integration_id") or "")
        if not integration_id:
            # Failed before the immutable integration id was resolved: there is no connection to
            # report against, and an id is never invented. Say so locally instead.
            log.warning(
                "Drive connection %s failed before its integration was resolved (%s); nothing reported",
                conn.name, ", ".join(sorted((summary.failure_categories or {}).keys())) or "unknown",
            )
            return
        if _REREAD_BEFORE_REPORTING & set(summary.failure_categories or {}):
            # The connection may have been paused or disconnected during this poll: before the
            # brain's authority check (`connection_unavailable`), or after this run had acquired its
            # execution, which a pause fences off (`stale_execution` on the next fenced request).
            # An unexpected coordinator error may be that same pause seen from a provider call.
            # That pause is not a failure — but an ENABLED connection refused this way is, so
            # re-read THIS connection, by its resolved id, and report unless it is now gone or paused.
            after = await _gdrive_admin_row(settings, conn, integration_id)
            if after is None or after.get("status") != "enabled":
                log.info("Drive connection %s was paused during the poll; nothing reported", conn.name)
                return
        status = _gdrive_outcome_status(summary)
        error = ", ".join(sorted((summary.failure_categories or {}).keys())) or None
        from .brain_client import BrainClient
        async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
            await client.report_scheduled_gdrive_run(
                report_id, integration_id, started, summary, status=status, error=error,
            )
        return
    since = state.get_cursor(conn.name)
    started = _now_iso()
    summary = await run_connection(settings, conn, since=since)
    # Advance the cursor only after a successful run, so a failure re-polls next time.
    if summary.failed == 0:
        state.set_cursor(conn.name, started)


async def _remote_gdrive_poll_job(
    settings: BrainSettings, connections: list[Connection], state: StateStore,
) -> None:
    """Poll the Admin-created OAuth Drive integrations that have no local connection entry.

    Admin state is re-read on every sweep, so an integration connected, paused or disconnected
    after the scheduler started is honored without a restart; a selection read failure raises and
    nothing runs. Which rows are runnable is decided by ``merge_selections`` alone (enabled OAuth
    only — a service-account row still needs its local credential entry), and a name that is
    configured locally stays with that connection's own ``poll:<name>`` job.
    """
    from .brain_client import BrainClient
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        remote = await client.fetch_integration_selections(include_disabled=True)
    configured = {conn.name for conn in connections if conn.source == "gdrive"}
    unconfigured = [
        row for row in remote
        if row.get("type") == "gdrive" and row.get("name") not in configured
    ]
    for conn in merge_selections([], unconfigured):
        try:
            await _poll_job(settings, conn, state)
        except Exception as exc:
            # One integration's failure must not starve the ones after it; the next sweep retries.
            log.warning("remote Drive poll for %s failed: %s", conn.name, type(exc).__name__)


async def _manual_gdrive_job(
    settings: BrainSettings, connections: list[Connection], state: StateStore,
) -> None:
    """Drain one durable Admin request through the ordinary Drive coordinator."""
    from .brain_client import BrainClient
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        request = await client.claim_gdrive_run_request()
    if request is None:
        return
    configured = next(
        (conn for conn in connections if conn.source == "gdrive" and conn.name == request.name),
        None,
    )
    connection = configured or Connection(
        request.name, "gdrive", options={"integration_id": request.integration_id, "auth_mode": "oauth"},
    )
    try:
        summary = await run_gdrive_stream(settings, connection, state)
        status = _gdrive_outcome_status(summary)
        error = ", ".join(sorted((summary.failure_categories or {}).keys())) or None
    except Exception as exc:  # never BaseException: cancellation and shutdown still propagate
        # The same fixed category as a scheduled run that raised: the exception's text and class
        # never reach the brain; only the class is logged here, for the operator.
        from .engine import IngestSummary
        log.warning("manual Drive run for %s raised %s; reporting it as %s",
                    connection.name, type(exc).__name__, _COORDINATOR_ERROR)
        summary = IngestSummary(connection.name, failed=1, failure_categories={_COORDINATOR_ERROR: 1})
        status = "failed"
        error = _COORDINATOR_ERROR
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        await client.complete_gdrive_run_request(request, summary, status=status, error=error)


# At most this many connections are woken by one hint sweep; the rest wait for the next sweep.
_HINT_RUNS_PER_SWEEP = 4


async def _gdrive_hint_job(
    settings: BrainSettings, connections: list[Connection], state: StateStore,
    attempted: dict[str, int], *, limit: int = _HINT_RUNS_PER_SWEEP,
) -> None:
    """Drain Drive streams that a validated notification marked dirty, without waiting for the poll.

    A notification is only a hint (``stream_hints``): the webhook never reads the provider. This
    sweep turns pending hints into ONE ordinary coordinator run per connection — the same
    ``_poll_job`` → ``run_gdrive_stream`` path as scheduled polling, so the brain's execution lease,
    generation fence and connection state still decide whether anything is read or written, and a
    run already holding the lease simply refuses this one. That run reads the change stream, which
    acknowledges exactly the hints it observed.

    Coalesced and bounded: a connection is woken only when its hint marker has grown since the last
    wake (``attempted``, updated BEFORE the run, so a failed or refused run is not retried every
    sweep — the next notification or the regular poll retries it), at most ``limit`` connections per
    sweep. Admin state is re-read first: a paused, disconnected or unknown connection is not woken,
    and a selection read failure wakes nothing.
    """
    pending = state.pending_hint_connections(settings.team)
    due = [(cid, marker) for cid, marker in pending.items() if marker > attempted.get(cid, 0)]
    if not due:
        return
    from .brain_client import BrainClient
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        remote = await client.fetch_integration_selections(include_disabled=True)
    by_id = {str(row.get("id")): row for row in remote if row.get("type") == "gdrive"}
    for cid, marker in due[:limit]:
        attempted[cid] = marker
        row = by_id.get(cid)
        if not row or row.get("status") != "enabled":
            continue
        configured = next(
            (conn for conn in connections if conn.source == "gdrive" and conn.name == row.get("name")),
            None,
        )
        connection = configured or next(iter(merge_selections([], [row])), None)
        if connection is None:
            continue
        try:
            await _poll_job(settings, connection, state)
        except Exception as exc:
            # One connection's failure must not starve the others; its hint stays pending.
            log.warning("Drive notification drain for %s failed: %s", connection.name, type(exc).__name__)


def _gdrive_outcome_status(summary) -> str:
    """Use coordinator evidence, never counter optimism, to classify a Drive run.

    ``deferred`` wins, and only the ``execution_busy`` refusal sets it (another coordinator holds the
    lease; this run did nothing). Run-deadline and discovery/work budget stops never set
    ``deferred``: their outstanding work is carried by the measured ``backlog`` when one is
    available, and they classify below. (Only the pre-drain run-deadline stop also adds ``skipped``,
    by exactly one; the page-loop and drain-loop deadline stops and the budget stops add none.) Then
    authoritative completion — including a valid EMPTY one — is ``complete``. A run that only FAILED
    is ``failed``: failed work, no document it created, updated, kept or removed, and no measured
    backlog to resume (a raised run, a refused authority). Counting that as partial presented a
    failure as progress. Everything else that did or holds work is ``partial``: real progress (even
    beside failures), a skipped-only stop, and any run whose measured backlog says the next run
    resumes it.

    This is the reported status only. Whether a run touches the Admin run ledger is decided
    separately by the brain (`lib/integrations/gdrive-run-ledger.ts`): a ``partial`` with no failed
    work is neutral there, but a ``partial`` that failed work is a failure.
    """
    if summary.deferred:
        return "deferred"
    if summary.authoritative_complete:
        return "complete"
    succeeded = summary.created + summary.updated + summary.unchanged + summary.removed
    if summary.failed > 0 and succeeded == 0 and summary.backlog is None:
        return "failed"
    if summary.total > 0 or summary.backlog is not None:
        return "partial"
    return "failed"


async def _renewal_job(
    state: StateStore, manager: WatchManager, connections: list[Connection],
    settings: BrainSettings | None = None,
) -> None:
    # Re-read authoritative Admin state on every sweep. A scheduler that started while enabled must
    # not renew a watch after pause/disconnect, and a selection read failure fails closed.
    now = _now_iso()
    channels = state.list_channels(active_only=True)
    if settings is None:  # unit/local compatibility; production always supplies settings.
        configured = {conn.name for conn in connections}
        for ch in due_for_renewal([c for c in channels if c.connection in configured], now):
            progress = state.get_progress(ch.namespace) if ch.namespace else None
            page_token = (progress.page_token or progress.baseline_start_token) if progress else None
            state.save_channel(manager.renew(ch, page_token))
        return

    # The fenced lifecycle (AIO-1167 R41): durable intent before dispatch, bounded offloaded
    # provider work, uncertain-outcome recovery and cleanup, renewal-owned state that never touches
    # a cursor. Admin state is re-read there on every sweep; pause/disconnect renews nothing.
    from .watch_renewal import renew_watches
    await renew_watches(state, manager, connections, settings)
    for ch in channels:
        if ch.expires_at and _parse(ch.expires_at) <= _parse(now):
            state.retire_channel(ch.connection, ch.channel_id, at=now)


def run(
    settings: BrainSettings,
    connections: list[Connection],
    *,
    state: StateStore,
    poll_interval: int = 300,
    renewal_interval: int = 1800,
    watch_manager: WatchManager | None = None,
    bootstrap_remote_gdrive: bool = False,
) -> None:
    """Build, start, and serve the scheduler until interrupted."""
    sched = build_scheduler(
        settings,
        connections,
        state=state,
        poll_interval=poll_interval,
        renewal_interval=renewal_interval,
        watch_manager=watch_manager,
        bootstrap_remote_gdrive=bootstrap_remote_gdrive,
    )

    async def _serve() -> None:
        sched.start()
        try:
            await asyncio.Event().wait()  # run forever
        finally:
            sched.shutdown(wait=False)

    asyncio.run(_serve())
