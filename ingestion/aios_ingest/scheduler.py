"""Scheduled polling + Drive watch-channel renewal.

APScheduler runs each connection's incremental poll on an interval (sha256 dedup at the
brain makes re-polls cheap no-ops), and a periodic sweep renews Google Drive watch
channels before they expire. The renewal *selection* (``due_for_renewal``) is pure and
unit-tested; the actual Drive API call lives behind a pluggable WatchManager.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Protocol

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .config import BrainSettings, Connection
from .engine import run_connection
from .state import Channel, StateStore, StreamKey
from .gdrive_sync import credential_identity, run_gdrive_stream
from .selections import effective_gdrive_connection

# Renew a watch channel this many seconds before its stated expiry.
_RENEWAL_SKEW = 600


class WatchManager(Protocol):
    """Renews an expiring push/watch channel, returning the replacement."""

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
) -> AsyncIOScheduler:
    """Register a poll job per connection (+ a renewal sweep if a WatchManager is given).
    Does not start the scheduler — caller starts it (see :func:`run`)."""
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

    if any(conn.source == "gdrive" for conn in connections):
        sched.add_job(
            _manual_gdrive_job,
            "interval",
            seconds=min(15, max(5, poll_interval)),
            id="gdrive-manual-queue",
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


async def _poll_job(settings: BrainSettings, conn: Connection, state: StateStore) -> None:
    if conn.source == "gdrive":
        started = _now_iso()
        report_id = str(uuid.uuid4())
        summary = await run_gdrive_stream(settings, conn, state)
        integration_id = summary.integration_id or str(conn.options.get("integration_id") or "")
        if integration_id:
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
    except Exception as exc:
        from .engine import IngestSummary
        summary = IngestSummary(connection.name, failed=1, failure_categories={type(exc).__name__: 1})
        status = "failed"
        error = type(exc).__name__
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        await client.complete_gdrive_run_request(request, summary, status=status, error=error)


def _gdrive_outcome_status(summary) -> str:
    """Use coordinator evidence, never counter optimism, to classify a Drive run."""
    if summary.deferred:
        return "deferred"
    if summary.authoritative_complete:
        return "complete"
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

    try:
        from .brain_client import BrainClient
        async with BrainClient(settings.base_url, settings.api_key, settings.team) as discovery:
            remote = await discovery.fetch_integration_selections(include_disabled=True)
    except Exception:
        return
    remote_by_name = {
        str(row.get("name")): row for row in remote
        if row.get("type") == "gdrive" and row.get("status") == "enabled"
    }
    for conn in (candidate for candidate in connections if candidate.source == "gdrive"):
        row = remote_by_name.get(conn.name)
        if not row or not row.get("id"):
            continue
        execution = None
        provider_gate = None
        try:
            async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
                execution = await client.acquire_gdrive_execution(str(row["id"]), str(uuid.uuid4()))
                effective = effective_gdrive_connection(conn, execution.config, execution.integration_id)
                account_id = str(
                    execution.config.get("authenticatedAccountId")
                    or execution.config.get("authenticatedAccount")
                    or credential_identity(effective.options)
                )
                token = None
                auth_mode = str(effective.options.get("auth_mode") or "oauth")
                if auth_mode == "oauth":
                    token = (await client.broker_gdrive_access_token(execution))["access_token"]
                elif not (effective.options.get("service_account_key_path") or effective.options.get("credential_json")):
                    continue
                provider_gate = client.gdrive_provider_gate(execution)
                progress_doc = dict(execution.progress)
                stream_map = progress_doc.get("streams")
                if isinstance(stream_map, dict):
                    streams = [(str(drive_id), dict(progress)) for drive_id, progress in stream_map.items()
                               if isinstance(progress, dict)]
                else:
                    streams = [(str(progress_doc.get("drive_id") or ""), progress_doc)]
                for drive_id, progress in streams:
                    page_token = str(progress.get("page_token") or progress.get("baseline_start_token") or "")
                    if not drive_id or not page_token:
                        continue
                    namespace = StreamKey(
                        settings.team, execution.integration_id, account_id, drive_id,
                    ).namespace(execution.generation)
                    current_channels = [
                        channel for channel in state.list_channels(conn.name, active_only=True)
                        if channel.namespace == namespace
                    ]
                    current = current_channels[0] if current_channels else None
                    if current and current not in due_for_renewal([current], now):
                        continue
                    channel = current or Channel(
                        conn.name, "bootstrap", None,
                        "1970-01-01T00:00:00+00:00", namespace,
                    )
                    replacement = manager.renew(
                        channel, page_token, token, provider_gate, drive_id,
                    )
                    updated_stream = dict(progress)
                    updated_stream.update({
                        "drive_id": drive_id,
                        "page_token": page_token,
                        "watch_channel_id": replacement.channel_id,
                        "watch_resource_id": replacement.resource_id,
                        "watch_expires_at": replacement.expires_at,
                    })
                    if isinstance(stream_map, dict):
                        updated_map = dict(progress_doc.get("streams") or {})
                        updated_map[drive_id] = updated_stream
                        checkpoint = {**progress_doc, "version": 2, "streams": updated_map,
                                      **updated_stream}
                    else:
                        checkpoint = updated_stream
                    ack = await client.checkpoint_gdrive_execution(execution, checkpoint) or {}
                    progress_doc = dict(ack.get("progress") or checkpoint)
                    stream_map = progress_doc.get("streams")
                    execution.progress.clear()
                    execution.progress.update(progress_doc)
                    state.save_channel(replacement)
        except Exception:
            # Fail closed: the old overlapping channel and polling remain in place.
            continue
        finally:
            if provider_gate is not None:
                try:
                    provider_gate.close()
                except Exception:
                    pass
            if execution is not None:
                try:
                    async with BrainClient(settings.base_url, settings.api_key, settings.team) as releaser:
                        await releaser.release_gdrive_execution(execution)
                except Exception:
                    pass
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
) -> None:
    """Build, start, and serve the scheduler until interrupted."""
    sched = build_scheduler(
        settings,
        connections,
        state=state,
        poll_interval=poll_interval,
        renewal_interval=renewal_interval,
        watch_manager=watch_manager,
    )

    async def _serve() -> None:
        sched.start()
        try:
            await asyncio.Event().wait()  # run forever
        finally:
            sched.shutdown(wait=False)

    asyncio.run(_serve())
