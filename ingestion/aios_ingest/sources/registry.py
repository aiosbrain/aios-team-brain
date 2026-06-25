"""Source registry: maps a source type to its adapter constructor.

Adding a new LlamaHub-backed source is ~one entry here plus a small adapter module.
Builders receive the connection's ``options`` dict (from config/CLI) as kwargs.
"""

from __future__ import annotations

from typing import Any, Callable

from .base import Source
from .confluence import ConfluenceSource
from .gdrive import GoogleDriveSource
from .granola import GranolaSource
from .local import LocalSource
from .notion import NotionSource
from .radar import RadarSource
from .slack import SlackSource
from .web import WebSource

Builder = Callable[..., Source]

_REGISTRY: dict[str, Builder] = {
    "slack": SlackSource,
    "notion": NotionSource,
    "gdrive": GoogleDriveSource,
    "confluence": ConfluenceSource,
    "web": WebSource,
    "local": LocalSource,
    "radar": RadarSource,
    "granola": GranolaSource,
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
