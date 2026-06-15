"""Slack source — wraps llama-index-readers-slack.

Pull via SlackReader over channel ids. Webhooks use Slack's signing-secret scheme
(HMAC-SHA256 over ``v0:{timestamp}:{body}``); the Events API also requires echoing the
``url_verification`` challenge, handled in webhook_app.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any, Iterator

from ..normalize import RawDoc
from .base import Source
from ._llamahub import docs_to_raw, lazy_reader


class SlackSource(Source):
    name = "slack"
    supports_webhook = True

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
        SlackReader = lazy_reader(
            "llama_index.readers.slack", "SlackReader", "slack", "llama-index-readers-slack"
        )
        reader = SlackReader(slack_token=self._token)
        docs = reader.load_data(channel_ids=self._channel_ids)
        yield from docs_to_raw(
            docs, source=self.name, id_keys=("channel", "channel_id", "ts"), fallback_prefix="slack"
        )

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
