"""Radar source — the Agentic Engineering Radar.

Mines the best practicing agentic engineers into the brain (team-tier) by pulling
their public RSS/Atom feeds, GitHub `releases.atom` feeds, and Hacker News keyword
feeds (hnrss). Each feed entry becomes one `RawDoc` (kind ``artifact``, access
``team``) keyed by its permalink, so re-pulling is dedupe-safe via the brain's
content sha256.

Curated, high-signal items are later promoted to the public wiki — a deliberate human
act (see docs/agentic radar promotion), never automatic. This source only fills the
team-tier staging layer.

The feed list is data: pass it inline via ``feeds`` (a list of URLs) or point
``watchlist_path`` at a watchlist JSON (the monorepo-canonical
``agentic-engineering-maturity/rubric/watchlist.json`` shape) and the source pulls its
``feeds[].url`` + ``githubReleaseFeeds[].url`` + ``hnQueries[].url``.

Pull-only. Needs the 'radar' extra (feedparser).
"""

from __future__ import annotations

import json
from typing import Iterator

import httpx

from ..normalize import RawDoc
from .base import MissingExtraError, PullOnlySource, Source


def _feeds_from_watchlist(path: str) -> list[str]:
    with open(path, encoding="utf-8") as fh:
        wl = json.load(fh)
    urls: list[str] = []
    for key in ("feeds", "githubReleaseFeeds", "hnQueries"):
        for entry in wl.get(key, []):
            url = entry.get("url") if isinstance(entry, dict) else entry
            if url:
                urls.append(url)
    return urls


def _struct_to_iso(parsed) -> str | None:
    """feedparser's *_parsed time.struct_time → ISO8601 (UTC), or None."""
    if not parsed:
        return None
    import calendar
    from datetime import datetime, timezone

    try:
        return datetime.fromtimestamp(calendar.timegm(parsed), tz=timezone.utc).isoformat()
    except (ValueError, OverflowError, TypeError):
        return None


class RadarSource(PullOnlySource, Source):
    name = "radar"

    def __init__(
        self,
        *,
        feeds: list[str] | None = None,
        watchlist_path: str | None = None,
        timeout: float = 30.0,
        max_entries_per_feed: int = 50,
    ):
        # feeds may arrive as a comma-separated string via the CLI `--opt feeds=a,b`.
        if isinstance(feeds, str):
            feeds = [u.strip() for u in feeds.split(",") if u.strip()]
        urls = list(feeds or [])
        if watchlist_path:
            urls.extend(_feeds_from_watchlist(watchlist_path))
        # de-dupe, preserve order
        seen: set[str] = set()
        self._urls = [u for u in urls if not (u in seen or seen.add(u))]
        if not self._urls:
            raise ValueError("radar source needs `feeds` or a `watchlist_path` with feeds")
        # CLI `--opt` values arrive as strings — coerce the numerics.
        self._timeout = float(timeout)
        self._max = int(max_entries_per_feed)

    def fetch(self, *, since: str | None = None) -> Iterator[RawDoc]:
        try:
            import feedparser  # type: ignore
        except ImportError:
            raise MissingExtraError("radar", "feedparser") from None

        with httpx.Client(timeout=self._timeout, follow_redirects=True) as http:
            for feed_url in self._urls:
                try:
                    resp = http.get(feed_url, headers={"User-Agent": "aios-radar/1.0"})
                except httpx.HTTPError:
                    continue
                if resp.status_code != 200:
                    continue
                parsed = feedparser.parse(resp.content)
                feed_title = (parsed.feed or {}).get("title") if hasattr(parsed, "feed") else None

                for entry in (parsed.entries or [])[: self._max]:
                    link = entry.get("link") or entry.get("id")
                    if not link:
                        continue
                    ts = _struct_to_iso(entry.get("published_parsed") or entry.get("updated_parsed"))
                    # cursor filter: skip entries at/older than `since` when both are known
                    if since and ts and ts <= since:
                        continue

                    title = (entry.get("title") or "").strip() or None
                    author = (entry.get("author") or "").strip() or feed_title or None
                    summary = entry.get("summary") or ""
                    if not summary and entry.get("content"):
                        summary = entry["content"][0].get("value", "")

                    body = "\n\n".join(
                        part for part in (f"# {title}" if title else "", link, summary.strip()) if part
                    )

                    yield RawDoc(
                        source=self.name,
                        external_id=link,
                        body=body,
                        title=title,
                        url=link,
                        author=author,
                        source_ts=ts,
                        kind="artifact",
                        access="team",
                        extra_frontmatter={
                            "radar": True,
                            "feed": feed_url,
                            "feed_title": feed_title,
                        },
                    )
