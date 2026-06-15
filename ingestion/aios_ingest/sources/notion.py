"""Notion source — wraps llama-index-readers-notion.

Notion webhooks (2026, beta) fire on page-property changes but not block edits, so
content sync relies on the poller; this adapter is pull-based.
"""

from __future__ import annotations

from typing import Iterator

from ..normalize import RawDoc
from .base import PullOnlySource, Source
from ._llamahub import docs_to_raw, lazy_reader


class NotionSource(PullOnlySource, Source):
    name = "notion"

    def __init__(self, *, token: str, page_ids: list[str] | None = None, database_id: str | None = None):
        if not page_ids and not database_id:
            raise ValueError("provide page_ids or database_id")
        self._token = token
        self._page_ids = page_ids
        self._database_id = database_id

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        NotionPageReader = lazy_reader(
            "llama_index.readers.notion", "NotionPageReader", "notion", "llama-index-readers-notion"
        )
        reader = NotionPageReader(integration_token=self._token)
        if self._database_id:
            docs = reader.load_data(database_id=self._database_id)
        else:
            docs = reader.load_data(page_ids=self._page_ids)
        yield from docs_to_raw(
            docs, source=self.name, id_keys=("page_id", "id"), fallback_prefix="notion"
        )
