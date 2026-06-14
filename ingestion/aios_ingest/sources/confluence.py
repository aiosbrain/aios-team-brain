"""Confluence source — wraps llama-index-readers-confluence.

Pull over a space key or explicit page ids. Pull-based; the scheduler re-polls.
"""

from __future__ import annotations

from typing import Iterator

from ..normalize import RawDoc
from .base import PullOnlySource, Source
from ._llamahub import docs_to_raw, lazy_reader


class ConfluenceSource(PullOnlySource, Source):
    name = "confluence"

    def __init__(
        self,
        *,
        base_url: str,
        space_key: str | None = None,
        page_ids: list[str] | None = None,
    ):
        if not space_key and not page_ids:
            raise ValueError("provide space_key or page_ids")
        self._base_url = base_url
        self._space_key = space_key
        self._page_ids = page_ids

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        ConfluenceReader = lazy_reader(
            "llama_index.readers.confluence",
            "ConfluenceReader",
            "confluence",
            "llama-index-readers-confluence",
        )
        # Credentials are read from env by the reader (CONFLUENCE_API_TOKEN, etc.).
        reader = ConfluenceReader(base_url=self._base_url)
        if self._space_key:
            docs = reader.load_data(space_key=self._space_key)
        else:
            docs = reader.load_data(page_ids=self._page_ids)
        yield from docs_to_raw(
            docs, source=self.name, id_keys=("page_id", "id"), fallback_prefix="confluence"
        )
