"""Notion source — wraps llama-index-readers-notion.

Notion webhooks (2026, beta) fire on page-property changes but not block edits, so
content sync relies on the poller; this adapter is pull-based.
"""

from __future__ import annotations

from typing import Iterator

from ..normalize import RawDoc
from .base import PullOnlySource, Source
from ._llamahub import docs_to_raw, lazy_reader
from .notion_authors import NotionAuthorClient


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
        raws = docs_to_raw(docs, source=self.name, id_keys=("page_id", "id"), fallback_prefix="notion")
        # Enrich each page with its Notion authors (created_by/last_edited_by → email) so items attribute
        # to real people. One reused client (user cache + 429 retry); a page whose id we only have as the
        # "notion-<i>" fallback can't be looked up, so we skip the API call for it.
        with NotionAuthorClient(self._token) as authors:
            for raw in raws:
                if not raw.external_id.startswith("notion-"):
                    found = authors.page_authors(raw.external_id)
                    if found:
                        raw.authors = found
                yield raw
