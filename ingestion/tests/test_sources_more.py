import httpx

from aios_ingest.sources import available_sources, build_source
from aios_ingest.sources.local import LocalSource
from aios_ingest.sources.web import WebSource, _extract

_REAL_CLIENT = httpx.Client  # captured before any monkeypatch rebinds httpx.Client


def _mock_client_factory(handler):
    return lambda **kw: _REAL_CLIENT(transport=httpx.MockTransport(handler))


def test_registry_includes_new_sources():
    assert {"web", "local"} <= set(available_sources())
    assert isinstance(build_source("local", {"root": "."}), LocalSource)


# -- local ----------------------------------------------------------------
def test_local_reads_text_and_skips_unknown(tmp_path):
    (tmp_path / "doc.md").write_text("# Title\nbody", encoding="utf-8")
    (tmp_path / "image.png").write_bytes(b"\x89PNG\r\n")
    (tmp_path / "sub").mkdir()
    (tmp_path / "sub" / "note.txt").write_text("hello", encoding="utf-8")

    docs = list(LocalSource(root=str(tmp_path)).fetch())
    ids = sorted(d.external_id for d in docs)
    assert ids == ["doc.md", "sub/note.txt"]  # png skipped
    md = next(d for d in docs if d.external_id == "doc.md")
    assert md.body == "# Title\nbody"
    assert md.source == "local"


# -- web ------------------------------------------------------------------
def test_extract_strips_scripts_and_reads_title():
    html = "<html><head><title>Hi</title><style>x{}</style></head><body><script>bad()</script><p>Real text</p></body></html>"
    title, text = _extract(html)
    assert title == "Hi"
    assert "Real text" in text
    assert "bad()" not in text and "x{}" not in text


def test_web_fetch_mocked(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<title>Page</title><body><p>Content here</p></body>")

    monkeypatch.setattr(httpx, "Client", _mock_client_factory(handler))
    docs = list(WebSource(urls=["https://example.com/a"]).fetch())
    assert len(docs) == 1
    assert docs[0].external_id == "https://example.com/a"
    assert "Content here" in docs[0].body
