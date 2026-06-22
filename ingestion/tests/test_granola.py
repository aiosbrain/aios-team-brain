"""Granola source — offline tests.

Spec-derived (CLAUDE.md §2): the hard product rule is *NO verbatim transcript synced
team-tier; meetings ingest as decision rows only, behind an allowlist + per-note consent*.
These tests assert that contract directly, plus the registry wiring, RawDoc normalization,
and mocked API pagination + 429 rate-limit behavior (no live API).
"""

import httpx
import pytest

from aios_ingest.normalize import NormalizeConfig, normalize
from aios_ingest.sources import available_sources, build_source
from aios_ingest.sources.granola import GranolaSource

_REAL_CLIENT = httpx.Client  # captured before any monkeypatch rebinds httpx.Client


def _mock_client_factory(handler):
    return lambda **kw: _REAL_CLIENT(transport=httpx.MockTransport(handler))


def _note(**kw):
    base = {
        "id": "n1",
        "title": "AIOS planning",
        "created_at": "2026-06-14T10:00:00Z",
        "participants": [{"name": "John Ellison", "email": "john@john-ellison.com"}],
        "tags": ["aios-consent"],
        "url": "https://granola.ai/notes/n1",
    }
    base.update(kw)
    return base


# ── registry wiring (W1.1.1) ──────────────────────────────────────────────────
def test_registry_includes_granola():
    assert "granola" in available_sources()
    assert isinstance(build_source("granola", {"api_key": "grn_x"}), GranolaSource)


def test_missing_api_key_raises():
    with pytest.raises(ValueError):
        build_source("granola", {"api_key": ""})


# ── privacy gate: allowlist + consent (W1.1.2) ─────────────────────────────────
def test_gate_allows_aios_topic_with_consent():
    src = GranolaSource(api_key="grn_x")
    assert src._allowed(_note(title="AIOS roadmap", participants=[], tags=["consent"]))


def test_gate_allows_allowlisted_participant_with_consent():
    src = GranolaSource(api_key="grn_x")
    n = _note(title="Weekly sync", participants=[{"name": "Chetan"}], tags=["share-decisions"])
    assert src._allowed(n)


def test_gate_blocks_offtopic_meeting():
    src = GranolaSource(api_key="grn_x")
    n = _note(title="Dentist appointment", participants=[{"name": "Bob"}], tags=["consent"])
    assert not src._allowed(n)


def test_gate_blocks_allowlisted_meeting_without_consent():
    # On-topic / right people, but NO consent marker → dropped entirely.
    src = GranolaSource(api_key="grn_x")
    n = _note(title="AIOS planning", tags=[], consent=None)
    n.pop("tags")
    assert not src._allowed(n)


def test_consent_via_title_token():
    src = GranolaSource(api_key="grn_x")
    assert src._allowed(_note(title="AIOS sync [aios]", tags=[]))


def test_require_consent_false_skips_consent_check():
    src = GranolaSource(api_key="grn_x", require_consent=False)
    assert src._allowed(_note(title="AIOS planning", tags=[]))


# ── team-push path emits METADATA-ONLY markers, NEVER transcript (W1.1.2) ──────
def test_fetch_yields_marker_without_transcript_text(monkeypatch):
    transcript_secret = "SECRET VERBATIM SPEECH that must never sync"
    page = {"data": [_note(transcript=transcript_secret)], "next_cursor": None}

    def handler(req: httpx.Request) -> httpx.Response:
        # The team-push path must NEVER call the transcript endpoint.
        assert "include=transcript" not in str(req.url)
        assert req.url.path.endswith("/v1/notes")
        return httpx.Response(200, json=page)

    monkeypatch.setattr(httpx, "Client", _mock_client_factory(handler))
    docs = list(GranolaSource(api_key="grn_x").fetch())
    assert len(docs) == 1
    d = docs[0]
    assert d.source == "granola"
    assert d.access == "team"
    assert d.kind == "artifact"  # NOT "transcript"
    assert transcript_secret not in d.body  # the hard rule
    assert d.external_id == "n1"
    assert d.extra_frontmatter["transcript_synced"] is False


def test_fetch_drops_unconsented_meetings(monkeypatch):
    page = {
        "data": [
            _note(id="ok", title="AIOS sync", tags=["consent"]),
            _note(id="nope", title="AIOS sync", tags=[]),  # no consent
            _note(id="offtopic", title="Lunch", participants=[{"name": "Stranger"}], tags=["consent"]),
        ],
        "next_cursor": None,
    }
    monkeypatch.setattr(
        httpx, "Client", _mock_client_factory(lambda req: httpx.Response(200, json=page))
    )
    docs = list(GranolaSource(api_key="grn_x").fetch())
    assert [d.external_id for d in docs] == ["ok"]


# ── pagination (W1.1.5) ─────────────────────────────────────────────────────────
def test_fetch_paginates_with_cursor(monkeypatch):
    pages = [
        {"data": [_note(id="a", title="AIOS a", tags=["consent"])], "next_cursor": "c1"},
        {"data": [_note(id="b", title="AIOS b", tags=["consent"])], "next_cursor": None},
    ]
    seen_cursors = []

    def handler(req: httpx.Request) -> httpx.Response:
        cursor = dict(req.url.params).get("cursor")
        seen_cursors.append(cursor)
        return httpx.Response(200, json=pages[len(seen_cursors) - 1])

    monkeypatch.setattr(httpx, "Client", _mock_client_factory(handler))
    docs = list(GranolaSource(api_key="grn_x").fetch())
    assert [d.external_id for d in docs] == ["a", "b"]
    assert seen_cursors == [None, "c1"]  # second request carried the cursor


# ── rate-limit 429 backoff (W1.1.5) ─────────────────────────────────────────────
def test_429_then_success_retries(monkeypatch):
    calls = {"n": 0}
    page = {"data": [_note(title="AIOS x", tags=["consent"])], "next_cursor": None}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, headers={"Retry-After": "0"}, json={"error": "rate"})
        return httpx.Response(200, json=page)

    monkeypatch.setattr(httpx, "Client", _mock_client_factory(handler))
    sleeps = []
    monkeypatch.setattr("aios_ingest.sources.granola.time.sleep", lambda s: sleeps.append(s))

    docs = list(GranolaSource(api_key="grn_x").fetch())
    assert len(docs) == 1
    assert calls["n"] == 2  # retried after the 429
    assert sleeps == [0.0]  # honored Retry-After


def test_persistent_429_raises(monkeypatch):
    monkeypatch.setattr(
        httpx,
        "Client",
        _mock_client_factory(lambda req: httpx.Response(429, json={"error": "rate"})),
    )
    monkeypatch.setattr("aios_ingest.sources.granola.time.sleep", lambda s: None)
    with pytest.raises(httpx.HTTPStatusError):
        list(GranolaSource(api_key="grn_x").fetch())


# ── local-only transcript pull is ADMIN-tier and never team-pushed (W1.1.3) ────
def test_pull_transcripts_writes_admin_tier_local_files(monkeypatch, tmp_path):
    list_page = {"data": [_note(id="n1", title="AIOS planning", tags=["consent"])], "next_cursor": None}
    full = _note(
        id="n1",
        title="AIOS planning",
        transcript=[
            {"speaker": "John", "text": "We will ship Wave A first."},
            {"speaker": "Chetan", "text": "Agreed."},
        ],
    )

    def handler(req: httpx.Request) -> httpx.Response:
        if "include=transcript" in str(req.url) or "/v1/notes/n1" in req.url.path:
            return httpx.Response(200, json=full)
        return httpx.Response(200, json=list_page)

    monkeypatch.setattr(httpx, "Client", _mock_client_factory(handler))
    dest = tmp_path / "transcripts"
    written = GranolaSource(api_key="grn_x").pull_transcripts(str(dest))
    assert len(written) == 1
    content = (dest / written[0].split("/")[-1]).read_text(encoding="utf-8") \
        if "/" in written[0] else open(written[0]).read()
    assert "access: admin" in content  # LOCAL only — never team-tier
    assert "We will ship Wave A first." in content  # full transcript lives locally only
    assert "John: We will ship Wave A first." in content


# ── normalization of the marker into an ItemPayload (W1.1.5) ────────────────────
def test_marker_normalizes_to_team_artifact_item(monkeypatch):
    page = {"data": [_note(id="Note 1", title="AIOS planning")], "next_cursor": None}
    monkeypatch.setattr(
        httpx, "Client", _mock_client_factory(lambda req: httpx.Response(200, json=page))
    )
    raw = next(iter(GranolaSource(api_key="grn_x").fetch()))
    item = normalize(raw, NormalizeConfig(default_project="aios", actor="granola-sync"))
    assert item.kind == "artifact"
    assert item.access == "team"
    assert item.path == "granola/note-1.md"  # slugified, stable
    assert item.project == "aios"
    assert item.frontmatter["transcript_synced"] is False
    assert item.frontmatter["source"] == "granola"
    # identical re-read hashes identically (dedupe-safe)
    raw2 = next(iter(GranolaSource(api_key="grn_x").fetch()))
    item2 = normalize(raw2, NormalizeConfig(default_project="aios", actor="granola-sync"))
    assert item.content_sha256 == item2.content_sha256
