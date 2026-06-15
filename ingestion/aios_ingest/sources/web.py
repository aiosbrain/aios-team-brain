"""Web source — fetches a list of URLs and extracts readable text.

Uses Unstructured's HTML partitioner when the 'docs' extra is installed (better
extraction); otherwise falls back to a dependency-free stdlib HTML-to-text stripper.
Pull-based; each URL is one item keyed by the URL.
"""

from __future__ import annotations

from html.parser import HTMLParser
from typing import Iterator

import httpx

from ..normalize import RawDoc
from .base import PullOnlySource, Source

_SKIP_TAGS = {"script", "style", "head", "noscript"}


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title: str | None = None
        self._chunks: list[str] = []
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP_TAGS:
            self._skip += 1
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag in _SKIP_TAGS and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and not self.title:
            self.title = data.strip() or None
        if self._skip == 0:
            text = data.strip()
            if text:
                self._chunks.append(text)

    @property
    def text(self) -> str:
        return "\n".join(self._chunks)


def _extract(html: str) -> tuple[str | None, str]:
    try:
        from unstructured.partition.html import partition_html  # type: ignore

        els = partition_html(text=html)
        body = "\n\n".join(str(e) for e in els if str(e).strip())
        # Title still comes from the stdlib parser (cheap).
        p = _TextExtractor()
        p.feed(html)
        return p.title, body or p.text
    except ImportError:
        p = _TextExtractor()
        p.feed(html)
        return p.title, p.text


class WebSource(PullOnlySource, Source):
    name = "web"

    def __init__(self, *, urls: list[str], timeout: float = 30.0):
        if not urls:
            raise ValueError("provide at least one url")
        self._urls = urls
        self._timeout = timeout

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        with httpx.Client(timeout=self._timeout, follow_redirects=True) as http:
            for url in self._urls:
                resp = http.get(url)
                if resp.status_code != 200:
                    continue
                title, text = _extract(resp.text)
                yield RawDoc(
                    source=self.name,
                    external_id=url,
                    body=text,
                    title=title,
                    url=url,
                )
