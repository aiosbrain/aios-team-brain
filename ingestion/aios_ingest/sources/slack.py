"""Slack source — DEPRECATED, ingests nothing.

Slack is synced by the brain's IN-APP runner (`lib/ingest/run.runSlackIngestion`), which models a
THREAD as one item: per-participant credit, per-thread work-time, and paths keyed on the immutable
channel id. This source modelled a whole CHANNEL as one document, so running both double-ingests
every conversation under two incompatible units of knowledge.

The class stays registered so an existing ``type: "slack"`` connection degrades to a warning rather
than failing the operator's entire sidecar run with "unknown source". The signing-secret helpers are
kept because they are the documented Slack webhook scheme and cost nothing to retain.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
from typing import Any, Iterator

from ..normalize import RawDoc
from .base import Source

logger = logging.getLogger(__name__)


class SlackSource(Source):
    name = "slack"
    # False since the source was deprecated: `fetch` ingests nothing, so advertising webhook support
    # would make the receiver verify a signature, drop the payload, and return 2xx to Slack — an
    # accept-and-discard that looks healthy from both sides. Reject explicitly instead.
    supports_webhook = False

    def __init__(
        self,
        *,
        token: str,
        channel_ids: list[str],
        signing_secret: str | None = None,
    ):
        self._token = token
        self._channel_ids = channel_ids
        self._signing_secret = signing_secret

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        """DEPRECATED — yields nothing.

        Slack is ingested by the brain's IN-APP runner (`lib/ingest/run.runSlackIngestion`), which
        models a THREAD as one item: per-participant credit, per-thread work-time, and paths keyed on
        the immutable channel id. This source models a whole CHANNEL as one document, so enabling it
        alongside the runner double-ingests every conversation under an incompatible unit of
        knowledge — one giant, ever-churning, unattributed item per channel.

        It degrades to a no-op rather than raising so an existing `type: "slack"` connection doesn't
        fail the operator's whole sidecar run; the warning says what to do instead.
        """
        logger.warning(
            "slack: the sidecar Slack source is deprecated and ingests nothing. Slack is synced by "
            "the brain's in-app runner (Admin → Integrations → Slack); remove this connection."
        )
        return
        yield  # pragma: no cover - unreachable, keeps this a generator


    def verify_webhook(self, headers: dict[str, str], raw_body: bytes) -> bool:
        if not self._signing_secret:
            return False
        ts = headers.get("x-slack-request-timestamp", "")
        sig = headers.get("x-slack-signature", "")
        basestring = b"v0:" + ts.encode() + b":" + raw_body
        expected = "v0=" + hmac.new(
            self._signing_secret.encode(), basestring, hashlib.sha256
        ).hexdigest()
        return hmac.compare_digest(sig, expected)

    def fetch_for_webhook(self, headers: dict[str, str], payload: dict[str, Any]) -> Iterator[RawDoc]:
        # Re-pull the channel the event touched; content-level diffing is left to
        # sha256 dedup at the brain.
        event = payload.get("event", {})
        channel = event.get("channel")
        if not channel:
            return iter(())
        prev = self._channel_ids
        self._channel_ids = [channel]
        try:
            yield from self.fetch()
        finally:
            self._channel_ids = prev
