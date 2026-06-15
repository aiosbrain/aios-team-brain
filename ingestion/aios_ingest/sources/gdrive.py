"""Google Drive source — wraps llama-index-readers-google-drive.

Pull over a folder or explicit file ids. Real-time uses Drive push notifications
(watch channels) which expire and must be renewed by the scheduler; for the MVP this
adapter is pull-based and the scheduler re-polls.
"""

from __future__ import annotations

from typing import Iterator

from ..normalize import RawDoc
from .base import PullOnlySource, Source
from ._llamahub import docs_to_raw, lazy_reader


class GoogleDriveSource(PullOnlySource, Source):
    name = "gdrive"

    def __init__(
        self,
        *,
        folder_id: str | None = None,
        file_ids: list[str] | None = None,
        service_account_key_path: str | None = None,
    ):
        if not folder_id and not file_ids:
            raise ValueError("provide folder_id or file_ids")
        self._folder_id = folder_id
        self._file_ids = file_ids
        self._key_path = service_account_key_path

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        GoogleDriveReader = lazy_reader(
            "llama_index.readers.google",
            "GoogleDriveReader",
            "gdrive",
            "llama-index-readers-google",
        )
        kwargs = {}
        if self._key_path:
            kwargs["service_account_key_path"] = self._key_path
        reader = GoogleDriveReader(**kwargs)
        if self._folder_id:
            docs = reader.load_data(folder_id=self._folder_id)
        else:
            docs = reader.load_data(file_ids=self._file_ids)
        yield from docs_to_raw(
            docs, source=self.name, id_keys=("file id", "file_id", "id"), fallback_prefix="gdrive"
        )
