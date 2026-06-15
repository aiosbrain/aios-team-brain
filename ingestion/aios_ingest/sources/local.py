"""Local filesystem source — walks a directory and ingests files.

Text/markdown files are read directly; recognized binary documents (pdf/docx/pptx) are
extracted via Unstructured (the 'docs' extra). Pull-based; each file is one item keyed by
its path relative to the root.
"""

from __future__ import annotations

import fnmatch
from pathlib import Path
from typing import Iterator

from ..normalize import RawDoc
from .base import PullOnlySource, Source

_TEXT_EXT = {".md", ".txt", ".markdown", ".rst", ".csv", ".json", ".yaml", ".yml"}
_BINARY_EXT = {".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".html", ".htm"}


class LocalSource(PullOnlySource, Source):
    name = "local"

    def __init__(self, *, root: str, glob: str = "**/*"):
        self._root = Path(root).expanduser().resolve()
        if not self._root.is_dir():
            raise ValueError(f"root is not a directory: {self._root}")
        self._glob = glob

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        for p in sorted(self._root.glob(self._glob)):
            if not p.is_file():
                continue
            if not fnmatch.fnmatch(p.name, "*"):  # glob already filtered; keep all matches
                continue
            ext = p.suffix.lower()
            body = self._read(p, ext)
            if body is None:
                continue
            rel = p.relative_to(self._root).as_posix()
            yield RawDoc(
                source=self.name,
                external_id=rel,
                body=body,
                title=p.name,
                url=p.as_uri(),
                source_ts=_mtime_iso(p),
            )

    def _read(self, p: Path, ext: str) -> str | None:
        if ext in _TEXT_EXT or ext == "":
            try:
                return p.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                return None
        if ext in _BINARY_EXT:
            from ..parsers import extract_text  # lazy: needs the 'docs' extra

            return extract_text(str(p))
        return None  # unknown/unsupported extension — skip


def _mtime_iso(p: Path) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(p.stat().st_mtime, tz=timezone.utc).isoformat()
