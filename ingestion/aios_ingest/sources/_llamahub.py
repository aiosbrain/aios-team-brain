"""Shared helpers for LlamaHub-reader-backed adapters.

LlamaHub readers return ``llama_index.core.schema.Document`` objects (``.text`` +
``.metadata``). This module maps those to our :class:`RawDoc` and centralizes the
lazy-import-with-helpful-error pattern so each adapter stays tiny.
"""

from __future__ import annotations

import importlib
from typing import Any, Iterable

from ..normalize import RawDoc
from .base import MissingExtraError


def lazy_reader(module: str, cls: str, extra: str, package: str):
    """Import ``cls`` from ``module`` or raise a MissingExtraError naming the extra."""
    try:
        mod = importlib.import_module(module)
    except ImportError as e:  # pragma: no cover - exercised via adapters
        raise MissingExtraError(extra, package) from e
    return getattr(mod, cls)


def _first(meta: dict[str, Any], *keys: str) -> str | None:
    for k in keys:
        v = meta.get(k)
        if v:
            return str(v)
    return None


def docs_to_raw(
    documents: Iterable[Any],
    *,
    source: str,
    id_keys: tuple[str, ...],
    fallback_prefix: str,
) -> list[RawDoc]:
    """Convert LlamaHub Documents to RawDocs, deriving a stable external_id."""
    out: list[RawDoc] = []
    for i, d in enumerate(documents):
        meta: dict[str, Any] = getattr(d, "metadata", None) or {}
        external_id = _first(meta, *id_keys) or f"{fallback_prefix}-{i}"
        out.append(
            RawDoc(
                source=source,
                external_id=external_id,
                body=getattr(d, "text", "") or "",
                title=_first(meta, "title", "file_name", "page_title", "name"),
                url=_first(meta, "url", "source", "page_url", "file_path"),
                author=_first(meta, "author", "creator", "user", "owner"),
                source_ts=_first(meta, "last_edited_time", "modified_time", "updated_at", "timestamp"),
                extra_frontmatter={k: v for k, v in meta.items() if isinstance(v, (str, int, float, bool))},
            )
        )
    return out
