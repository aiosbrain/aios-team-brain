"""The ingestion pipeline: fetch -> normalize -> push.

Shared by the CLI (backfill/poll) and the webhook app. Readers are synchronous, so
fetching runs in a worker thread; pushes are concurrent and throttled by BrainClient's
rate limiter. The brain's sha256 dedup makes re-runs idempotent.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from dataclasses import dataclass
from typing import Iterable

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

    @property
    def total(self) -> int:
        return self.created + self.updated + self.unchanged + self.failed

    def __str__(self) -> str:
        return (
            f"{self.connection}: {self.total} docs — "
            f"{self.created} created, {self.updated} updated, "
            f"{self.unchanged} unchanged, {self.failed} failed"
        )


async def _push_all(
    client: BrainClient, docs: Iterable[RawDoc], cfg: NormalizeConfig, name: str
) -> IngestSummary:
    counts: Counter[str] = Counter()

    async def push_one(doc: RawDoc) -> None:
        item = normalize(doc, cfg)
        try:
            result = await client.push(item)
            counts[result.status] += 1
        except BrainError:
            counts["failed"] += 1

    await asyncio.gather(*(push_one(d) for d in docs))
    return IngestSummary(
        connection=name,
        created=counts["created"],
        updated=counts["updated"],
        unchanged=counts["unchanged"],
        failed=counts["failed"],
    )


async def ingest_docs(
    settings: BrainSettings, docs: Iterable[RawDoc], cfg: NormalizeConfig, name: str
) -> IngestSummary:
    """Normalize and push an already-fetched batch (used by the webhook path)."""
    async with BrainClient(settings.base_url, settings.api_key, settings.team) as client:
        return await _push_all(client, list(docs), cfg, name)


async def run_connection(
    settings: BrainSettings, conn: Connection, *, since: str | None = None
) -> IngestSummary:
    """Build the source, fetch (in a thread), normalize, and push."""
    source: Source = build_source(conn.source, conn.options)
    docs = await asyncio.to_thread(lambda: list(source.fetch(since=since)))
    return await ingest_docs(settings, docs, conn.normalize_config(), conn.name)
