"""Radar source — offline tests (feed parsing, cursor filter, watchlist loading)."""

import json

import httpx

from aios_ingest.sources.radar import RadarSource, _feeds_from_watchlist, _struct_to_iso

ATOM = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Engineer</title>
  <entry>
    <title>Agentic coding tips</title>
    <link href="https://example.com/posts/agentic-tips"/>
    <id>https://example.com/posts/agentic-tips</id>
    <updated>2026-06-10T12:00:00Z</updated>
    <author><name>Jane Dev</name></author>
    <summary>Use a check the agent can run.</summary>
  </entry>
  <entry>
    <title>Older post</title>
    <link href="https://example.com/posts/old"/>
    <id>https://example.com/posts/old</id>
    <updated>2026-01-01T00:00:00Z</updated>
    <summary>Stale.</summary>
  </entry>
</feed>
"""


def _mock_get(monkeypatch, body: str, status: int = 200):
    def fake_get(self, url, headers=None):
        return httpx.Response(status, content=body.encode(), request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.Client, "get", fake_get)


def test_fetch_yields_team_tier_artifacts(monkeypatch):
    _mock_get(monkeypatch, ATOM)
    src = RadarSource(feeds=["https://example.com/feed.atom"])
    docs = list(src.fetch())
    assert len(docs) == 2
    d = docs[0]
    assert d.source == "radar"
    assert d.kind == "artifact"
    assert d.access == "team"  # never external/admin — staging is team-tier
    assert d.external_id == "https://example.com/posts/agentic-tips"
    assert d.author == "Jane Dev"
    assert "check the agent can run" in d.body
    assert d.extra_frontmatter["radar"] is True


def test_since_cursor_filters_old_entries(monkeypatch):
    _mock_get(monkeypatch, ATOM)
    src = RadarSource(feeds=["https://example.com/feed.atom"])
    docs = list(src.fetch(since="2026-03-01T00:00:00+00:00"))
    # only the June entry survives the cursor
    assert [d.external_id for d in docs] == ["https://example.com/posts/agentic-tips"]


def test_non_200_feed_is_skipped(monkeypatch):
    _mock_get(monkeypatch, "nope", status=503)
    src = RadarSource(feeds=["https://example.com/feed.atom"])
    assert list(src.fetch()) == []


def test_watchlist_loading(tmp_path):
    wl = {
        "feeds": [{"url": "https://a.com/feed"}],
        "githubReleaseFeeds": [{"url": "https://github.com/o/r/releases.atom"}],
        "hnQueries": [{"url": "https://hnrss.org/newest?q=x"}],
    }
    p = tmp_path / "watchlist.json"
    p.write_text(json.dumps(wl))
    urls = _feeds_from_watchlist(str(p))
    assert urls == [
        "https://a.com/feed",
        "https://github.com/o/r/releases.atom",
        "https://hnrss.org/newest?q=x",
    ]


def test_struct_to_iso_handles_none():
    assert _struct_to_iso(None) is None
