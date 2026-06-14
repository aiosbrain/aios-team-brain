"""Source adapter protocol.

Every adapter turns an external system into a stream of :class:`RawDoc`. Pull-based
adapters implement ``fetch``; adapters whose system supports webhooks additionally
verify and translate a webhook into the resource ids to (re)fetch. Heavy reader
libraries are imported lazily inside the adapter so the core stays installable alone.
"""

from __future__ import annotations

from typing import Any, Iterator, Protocol, runtime_checkable

from ..normalize import RawDoc


class MissingExtraError(RuntimeError):
    """Raised when an adapter needs an optional dependency that isn't installed."""

    def __init__(self, extra: str, package: str):
        super().__init__(
            f"This source needs the '{extra}' extra. Install it with:\n"
            f"    uv pip install 'aios-ingest[{extra}]'   # provides {package}"
        )


@runtime_checkable
class Source(Protocol):
    """A pluggable content source."""

    name: str
    supports_webhook: bool

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        """Yield documents changed since the ISO cursor (or all, if None)."""
        ...

    def verify_webhook(self, headers: dict[str, str], raw_body: bytes) -> bool:
        """Validate a webhook's signature. Pull-only sources return False."""
        ...

    def fetch_for_webhook(
        self, headers: dict[str, str], payload: dict[str, Any]
    ) -> Iterator[RawDoc]:
        """Translate a verified webhook into the affected documents to (re)ingest."""
        ...


class PullOnlySource:
    """Mixin default for sources without webhooks."""

    supports_webhook = False

    def verify_webhook(self, headers: dict[str, str], raw_body: bytes) -> bool:  # noqa: D102
        return False

    def fetch_for_webhook(self, headers, payload):  # noqa: D102
        return iter(())
