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


def _norm_key(key: str) -> str:
    """Lowercase + drop non-alphanumerics, so ``last_edited_time`` / ``modifiedTime`` /
    ``"Modified At"`` all collapse to one comparable token. Mirrors the brain's
    ``lib/ingest/work-time`` resolver."""
    return "".join(ch for ch in key.lower() if ch.isalnum())


def _first_normalized(meta: dict[str, Any], *keys: str) -> str | None:
    """Like :func:`_first`, but matches metadata keys by NORMALIZED name.

    Every LlamaHub reader spells its metadata differently (Notion ``last_edited_time``, Drive
    ``modified at``, others ``modifiedTime``), and an exact-match lookup silently returned ``None``
    for any spelling we didn't guess. That left ``source_ts`` empty, so the brain resolved no
    work-time and DROPPED the document from the timeline entirely — correctly ingested and
    attributed, yet invisible. Normalized matching lets a new reader's spelling work without
    another hardcoded alias.
    """
    index: dict[str, Any] = {}
    for k, v in meta.items():
        nk = _norm_key(str(k))
        if nk not in index:  # first spelling wins
            index[nk] = v
    for k in keys:
        v = index.get(_norm_key(k))
        # Strings only: the brain refuses a bare number as a timestamp (epoch seconds vs ms is
        # ambiguous and guessing wrong silently mis-dates work), so forwarding "1719878400" here
        # would just be dropped downstream. Skip to the next candidate key instead.
        if v and isinstance(v, str):
            return v
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
                # WORK-TIME. Matched spelling-insensitively across every reader's dialect, in the
                # brain's priority order (edit time beats creation time). An empty value here means
                # the doc has no work-time at all and the timeline drops it, so breadth matters.
                source_ts=_first_normalized(
                    meta,
                    "last_edited_time",
                    "last_modified_time",
                    "last_modified",
                    "modified_time",
                    "modified_at",
                    "modified",
                    "updated_at",
                    "updated",
                    "created_time",
                    "created_at",
                    "created",
                    "timestamp",
                ),
                extra_frontmatter={k: v for k, v in meta.items() if isinstance(v, (str, int, float, bool))},
            )
        )
    return out
