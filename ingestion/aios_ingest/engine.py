"""The ingestion pipeline: fetch -> normalize -> push.

Shared by the CLI (backfill/poll) and the webhook app. Readers are synchronous, so
fetching runs in a worker thread; pushes are concurrent and throttled by BrainClient's
rate limiter. The brain's sha256 dedup makes re-runs idempotent.
"""

from __future__ import annotations

import asyncio
import os
from collections import Counter
from dataclasses import dataclass
from typing import Iterable, Iterator

from .brain_client import BrainClient, BrainError
from .config import BrainSettings, Connection
from .normalize import NormalizeConfig, RawDoc, normalize
from .sources import build_source
from .sources.base import Source


@dataclass
class IngestSummary:
    connection: str
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    failed: int = 0
    skipped: int = 0
    removed: int = 0
    failure_categories: dict[str, int] | None = None
    # Google Drive's coordinator has durable work that is not reflected by the document counters.
    # These fields are deliberately nullable/explicit: zero backlog is evidence, while ``None``
    # means the coordinator could not authoritatively measure it (for example a busy lease).
    authoritative_complete: bool = False
    deferred: bool = False
    backlog: int | None = None
    cursor_age_seconds: float | None = None
    integration_id: str | None = None

    @property
    def total(self) -> int:
        return self.created + self.updated + self.unchanged + self.failed + self.skipped + self.removed

    def __str__(self) -> str:
        return (
            f"{self.connection}: {self.total} docs — "
            f"{self.created} created, {self.updated} updated, "
            f"{self.unchanged} unchanged, {self.removed} removed, "
            f"{self.skipped} skipped, {self.failed} failed"
        )


async def _push_all(
    client: BrainClient,
    docs: Iterable[RawDoc],
    cfg: NormalizeConfig,
    name: str,
    *,
    max_concurrency: int = 8,
    queue_size: int = 32,
) -> IngestSummary:
    counts: Counter[str] = Counter()
    categories: Counter[str] = Counter()
    queue: asyncio.Queue[RawDoc | None] = asyncio.Queue(maxsize=max(1, queue_size))
    path_ids: dict[str, str] = {}

    async def push_one(doc: RawDoc) -> None:
        if doc.extra_frontmatter.get("extraction_complete") is False:
            counts["failed"] += 1
            categories["incomplete_extraction"] += 1
            return
        item = normalize(doc, cfg)
        # Google provider ids remain exact in frontmatter; the historical path is lossy.  Refuse a
        # same-run collision instead of overwriting a different document.  The first item may be a
        # replay of an established legacy mapping, which is why its path remains unchanged.
        previous = path_ids.setdefault(item.path, doc.external_id)
        if previous != doc.external_id:
            counts["failed"] += 1
            categories["identity_collision"] += 1
            return
        try:
            result = await client.push(item)
            counts[result.status] += 1
        except BrainError as exc:
            counts["failed"] += 1
            categories[exc.code or "brain_error"] += 1

    async def worker() -> None:
        while True:
            doc = await queue.get()
            if doc is None:
                return
            await push_one(doc)

    async def produce() -> None:
        for doc in docs:
            await queue.put(doc)
        for _ in workers:
            await queue.put(None)

    workers = [asyncio.create_task(worker()) for _ in range(max(1, max_concurrency))]
    tasks = [asyncio.create_task(produce()), *workers]
    try:
        # A worker that dies on anything but BrainError (a normalize ValidationError, an uncaught
        # transport exception) stops consuming.  With a bounded queue the producer would then block
        # on put() and the remaining sentinels would never be delivered, so the first failure ends
        # the whole batch instead of waiting for a drain that cannot happen.
        await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
    finally:
        # Also reached on outer cancellation: no producer or worker may outlive this call.
        for task in tasks:
            task.cancel()
        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
    for outcome in outcomes:
        if isinstance(outcome, BaseException) and not isinstance(outcome, asyncio.CancelledError):
            raise outcome

    return IngestSummary(
        connection=name,
        created=counts["created"],
        updated=counts["updated"],
        unchanged=counts["unchanged"],
        failed=counts["failed"],
        skipped=counts["skipped"],
        failure_categories=dict(categories),
    )


async def ingest_docs(
    settings: BrainSettings,
    docs: Iterable[RawDoc],
    cfg: NormalizeConfig,
    name: str,
    *,
    max_concurrency: int = 8,
    queue_size: int = 32,
) -> IngestSummary:
    """Normalize and push an already-fetched batch (used by the webhook path)."""
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        return await _push_all(
            client, docs, cfg, name, max_concurrency=max_concurrency, queue_size=queue_size
        )


# The Drive coordinator's per-run work budget when the caller names none. Drive work is durable —
# what a run leaves is resumed by the next one — so a finite budget there bounds a run, not coverage.
GDRIVE_RUN_WORK_BUDGET = 5_000


async def run_connection(
    settings: BrainSettings,
    conn: Connection,
    *,
    since: str | None = None,
    max_concurrency: int = 8,
    queue_size: int = 32,
    max_docs: int | None = None,
    state=None,
) -> IngestSummary:
    """Build the source, fetch in bounded chunks, normalize, and push.

    No complete fetch is materialized and no coroutine is created per document: the source is read
    ``queue_size`` documents at a time, however long it is.

    A generic source has no durable continuation — most re-enumerate from the start and ignore
    ``since`` as a resume point — so by default a run drains it to the end: a cap would replay the
    same first documents on every poll and never reach the rest. ``max_docs`` is an explicit cap for
    a caller that wants one; a source with more left is then reported ``run_budget_exhausted``.
    Google Drive is always finite: ``max_docs`` or ``GDRIVE_RUN_WORK_BUDGET``.
    """
    # Every Drive entry point converges on the fenced coordinator. The generic fetch/push path has
    # no generation authority and `/api/v1/items` deliberately rejects Drive writes without it.
    if conn.source == "gdrive":
        from .gdrive_sync import run_gdrive_stream
        from .state import StateStore
        owned_state = state is None
        store = state or StateStore(os.environ.get("AIOS_STATE_DB", "aios_ingest_state.sqlite"))
        try:
            return await run_gdrive_stream(
                settings, conn, store,
                max_work=GDRIVE_RUN_WORK_BUDGET if max_docs is None else max_docs,
            )
        finally:
            if owned_state:
                store.close()

    source: Source = build_source(conn.source, conn.options)
    iterator = iter(source.fetch(since=since))
    total = IngestSummary(connection=conn.name, failure_categories={})
    consumed = 0
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        while max_docs is None or consumed < max_docs:
            take = queue_size if max_docs is None else min(queue_size, max_docs - consumed)
            chunk = await asyncio.to_thread(_take, iterator, take)
            if not chunk:
                break
            consumed += len(chunk)
            part = await _push_all(
                client,
                chunk,
                conn.normalize_config(),
                conn.name,
                max_concurrency=max_concurrency,
                queue_size=queue_size,
            )
            total.created += part.created
            total.updated += part.updated
            total.unchanged += part.unchanged
            total.skipped += part.skipped
            total.removed += part.removed
            total.failed += part.failed
            for key, value in (part.failure_categories or {}).items():
                total.failure_categories[key] = total.failure_categories.get(key, 0) + value
        if max_docs is not None and consumed >= max_docs:
            extra = await asyncio.to_thread(_take, iterator, 1)
            if extra:
                total.failed += 1
                total.failure_categories["run_budget_exhausted"] = 1
    return total


def _take(iterator: Iterator[RawDoc], count: int) -> list[RawDoc]:
    out: list[RawDoc] = []
    for _ in range(max(0, count)):
        try:
            out.append(next(iterator))
        except StopIteration:
            break
    return out
