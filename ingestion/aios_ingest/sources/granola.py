"""Granola source — REMOVED. Retired as a registered no-op so live configs don't hard-fail.

The Granola connector was removed from Team Brain: no transcripts are pulled, no meeting markers
are pushed, and there is no `GRANOLA_API_KEY` any more.

WHY THIS FILE STILL EXISTS. `build_source()` raises `unknown source '<name>'` for an unregistered
key, and the one-shot `sync` path has no per-connection try/except — so deleting the registry entry
outright would make a stale `source: granola` block in an operator's `connections.yaml` abort the
ENTIRE run, silently stopping every connection listed after it. Granola connections are live in the
field today, so that is a real outage, not a hypothetical. This mirrors the identical decision made
for the deprecated sidecar `slack` source (see `registry.py`): degrade to a warning that says what
to do, rather than fail the operator's whole sidecar.

Delete this module once no `connections.yaml` in the field names `granola`.

Meetings can still reach the brain: push a transcript through the `aios` CLI. Previously-ingested
granola items are untouched and still classify correctly — `granola` remains a recognized MEETING
and SIGNAL source on the read paths (`lib/meetings/from-items`, `lib/attribution/health`).
"""

from __future__ import annotations

import logging
from typing import Any, Iterator

from ..normalize import RawDoc
from .base import PullOnlySource, Source

logger = logging.getLogger(__name__)


class GranolaSource(PullOnlySource, Source):
    """Retired. Accepts any options a legacy connection carries, then ingests nothing."""

    name = "granola"

    def __init__(self, **_options: Any) -> None:
        # Deliberately permissive: a legacy block still passes `api_key`, `topics`, `participants`,
        # `require_consent`, … Rejecting them would reintroduce the very failure this stub prevents.
        pass

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        logger.warning(
            "granola: the Granola connector has been REMOVED and ingests nothing. Delete this "
            "connection from connections.yaml (and GRANOLA_API_KEY from your .env). To get meetings "
            "into the brain, push a transcript with `aios push`."
        )
        return
        yield  # pragma: no cover - unreachable, keeps this a generator
