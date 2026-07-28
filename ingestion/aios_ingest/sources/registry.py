"""Source registry: maps a source type to its adapter constructor.

Adding a new LlamaHub-backed source is ~one entry here plus a small adapter module.
Builders receive the connection's ``options`` dict (from config/CLI) as kwargs.
"""

from __future__ import annotations

from typing import Any, Callable

from .base import Source
from .confluence import ConfluenceSource
from .gdrive import GoogleDriveSource
from .local import LocalSource
from .notion import NotionSource
from .radar import RadarSource
from .slack import SlackSource
from .web import WebSource

Builder = Callable[..., Source]

# "slack" stays registered but is a DEPRECATED NO-OP (see SlackSource.fetch). Slack is ingested by
# the IN-APP runner, which models a thread as one item; the sidecar source models a whole CHANNEL as
# one item, so running both double-ingests Slack under two incompatible units of knowledge. It is
# kept in the registry (rather than removed) so an existing `type: "slack"` connection degrades to a
# warning instead of failing the operator's entire sidecar run with "unknown source".
_REGISTRY: dict[str, Builder] = {
    "slack": SlackSource,
    "notion": NotionSource,
    "gdrive": GoogleDriveSource,
    "confluence": ConfluenceSource,
    "web": WebSource,
    "local": LocalSource,
    "radar": RadarSource,
}


def available_sources() -> list[str]:
    return sorted(_REGISTRY)


def build_source(source_type: str, options: dict[str, Any]) -> Source:
    try:
        builder = _REGISTRY[source_type]
    except KeyError:
        raise ValueError(
            f"unknown source '{source_type}'. Available: {', '.join(available_sources())}"
        ) from None
    return builder(**options)
