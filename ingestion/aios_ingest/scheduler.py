"""Scheduled polling + Drive watch-channel renewal.

APScheduler runs each connection's incremental poll on an interval (sha256 dedup at the
brain makes re-polls cheap no-ops), and a periodic sweep renews Google Drive watch
channels before they expire. The renewal *selection* (``due_for_renewal``) is pure and
unit-tested; the actual Drive API call lives behind a pluggable WatchManager.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Protocol

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from .config import BrainSettings, Connection
from .engine import run_connection
from .state import Channel, StateStore

# Renew a watch channel this many seconds before its stated expiry.
_RENEWAL_SKEW = 600


class WatchManager(Protocol):
    """Renews an expiring push/watch channel, returning the replacement."""

    def renew(self, channel: Channel) -> Channel: ...


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

    if watch_manager is not None:
        sched.add_job(
            _renewal_job,
            "interval",
            seconds=renewal_interval,
            id="renewal-sweep",
            args=[state, watch_manager, connections],
            max_instances=1,
            coalesce=True,
        )
    return sched


async def _poll_job(settings: BrainSettings, conn: Connection, state: StateStore) -> None:
    since = state.get_cursor(conn.name)
    started = _now_iso()
    summary = await run_connection(settings, conn, since=since)
    # Advance the cursor only after a successful run, so a failure re-polls next time.
    if summary.failed == 0:
        state.set_cursor(conn.name, started)


async def _renewal_job(
    state: StateStore, manager: WatchManager, connections: list[Connection]
) -> None:
    channels = [c for c in (state.get_channel(conn.name) for conn in connections) if c]
    for ch in due_for_renewal(channels, _now_iso()):
        state.save_channel(manager.renew(ch))


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
