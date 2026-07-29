"""`fetch()` tests for the three reader-backed connectors — Notion, Google Drive, Confluence.

These were the connectors described as "wired but unproven": real registered code, no test of
`fetch()` for any of them, so their happy path had never run anywhere. We have no org account
for any of the three, so the reader is replaced at the `lazy_reader` seam (see `_reader_fakes`)
and the whole adapter body runs — reader construction, branch selection, and the metadata →
`RawDoc` mapping.

What this tier proves: our code is correct GIVEN the reader shape in `_reader_fakes`.
What it can NOT prove: that the shape is real, that a token authenticates, or that the live API
returns these metadata keys. The first of those is covered by `test_reader_api_conformance.py`
against the installed library; the rest genuinely need an account and are recorded as such in
`docs/TODO.md`.

The mapping assertions matter more than they look: `source_ts` is the item's WORK-TIME, and a
document that reaches the brain without one is ingested, attributed, and then silently dropped
from the timeline. Each reader spells that field differently, so each spelling is pinned here.
"""

from __future__ import annotations

import httpx
import pytest

from _reader_fakes import (
    FakeConfluenceReader,
    FakeDoc,
    FakeGoogleDriveReader,
    FakeNotionPageReader,
    install,
)
from aios_ingest.sources.base import MissingExtraError
from aios_ingest.sources.confluence import ConfluenceSource
from aios_ingest.sources.gdrive import GoogleDriveSource
from aios_ingest.sources.notion import NotionSource

_REAL_CLIENT = httpx.Client  # captured before any monkeypatch rebinds httpx.Client


def _no_notion_api(monkeypatch):
    """Notion's author enrichment calls the Notion API per page. Point it at a transport that
    fails every request, so the enrichment's best-effort contract is what's exercised — a page
    still yields, just unattributed. Tests that care about enrichment install their own."""

    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(500)

    monkeypatch.setattr(
        httpx, "Client", lambda **kw: _REAL_CLIENT(transport=httpx.MockTransport(handler))
    )


# -- Notion ---------------------------------------------------------------------------------
def test_notion_passes_the_token_and_loads_the_requested_pages(monkeypatch):
    _no_notion_api(monkeypatch)
    spy = install(
        monkeypatch,
        "notion",
        FakeNotionPageReader,
        docs=[FakeDoc(text="body text", metadata={"page_id": "p1"})],
    )

    docs = list(NotionSource(token="secret-tok", page_ids=["p1"]).fetch())

    assert spy.init_kwargs == {"integration_token": "secret-tok"}
    assert spy.load_kwargs == {"page_ids": ["p1"]}
    assert [(d.source, d.external_id, d.body) for d in docs] == [("notion", "p1", "body text")]


def test_notion_database_selection_reaches_the_reader(monkeypatch):
    """A `database_id` connection must actually load that database.

    Not a hypothetical branch: `connections.yaml.example` ships `database_id` as THE Notion
    example, so the copy-pasteable config is this path. The reader takes `database_ids` (plural,
    a LIST); a single-valued `database_id=` is not an alias, it is a TypeError — and `sync` has
    no per-connection try/except, so it aborts the operator's whole run and silently stops every
    connection listed after it. Same shape as the `--source github` example retired in #431.
    """
    _no_notion_api(monkeypatch)
    spy = install(
        monkeypatch,
        "notion",
        FakeNotionPageReader,
        docs=[FakeDoc(text="from db", metadata={"page_id": "p9"})],
    )

    docs = list(NotionSource(token="t", database_id="db-1").fetch())

    assert spy.load_kwargs == {"database_ids": ["db-1"]}
    assert [d.external_id for d in docs] == ["p9"]


def test_notion_requires_a_selection():
    with pytest.raises(ValueError):
        NotionSource(token="t")


def test_notion_enriches_authors_and_backfills_work_time(monkeypatch):
    """The reader's metadata carries only `page_id` — no author, no timestamp. Both come from
    the Notion API pass, and both are load-bearing: without authors the item lands on the
    connector account, without a work-time the timeline drops it."""

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/v1/pages/p1":
            return httpx.Response(
                200,
                json={
                    "created_by": {"id": "u1"},
                    "last_edited_by": {"id": "u2"},
                    "last_edited_time": "2026-07-20T10:00:00.000Z",
                },
            )
        if req.url.path == "/v1/users/u1":
            return httpx.Response(
                200, json={"type": "person", "name": "Ada", "person": {"email": "ada@x.co"}}
            )
        if req.url.path == "/v1/users/u2":
            return httpx.Response(200, json={"type": "bot", "name": "AIOS sync"})
        return httpx.Response(404)

    monkeypatch.setattr(
        httpx, "Client", lambda **kw: _REAL_CLIENT(transport=httpx.MockTransport(handler))
    )
    install(
        monkeypatch,
        "notion",
        FakeNotionPageReader,
        docs=[FakeDoc(text="b", metadata={"page_id": "p1"})],
    )

    (doc,) = list(NotionSource(token="t", page_ids=["p1"]).fetch())

    assert doc.source_ts == "2026-07-20T10:00:00.000Z"  # work-time, else the timeline drops it
    assert doc.authors == [
        {
            "role": "author",
            "provider": "notion",
            "external_id": "u1",
            "email": "ada@x.co",
            "display_name": "Ada",
        }
    ]  # the bot editor is excluded — it is never a mappable human


def test_notion_page_still_yields_when_the_api_pass_fails(monkeypatch):
    """Enrichment is best-effort by contract: an API hiccup must cost attribution, not the
    document. Losing the page instead would turn a transient 500 into missing content."""
    _no_notion_api(monkeypatch)
    install(
        monkeypatch,
        "notion",
        FakeNotionPageReader,
        docs=[FakeDoc(text="b", metadata={"page_id": "p1"})],
    )

    (doc,) = list(NotionSource(token="t", page_ids=["p1"]).fetch())

    assert doc.external_id == "p1"
    assert doc.authors is None and doc.source_ts is None


# -- Google Drive ---------------------------------------------------------------------------
def test_gdrive_folder_branch_and_metadata_mapping(monkeypatch):
    """Drive's reader spells its metadata with SPACES (`file id`, `modified at`). The work-time
    lookup is spelling-insensitive and must match `modified at`; a miss here is silent — the
    doc ingests and never appears on the timeline."""
    spy = install(
        monkeypatch,
        "gdrive",
        FakeGoogleDriveReader,
        docs=[
            FakeDoc(
                text="drive body",
                metadata={
                    "file id": "f1",
                    # A DISPLAY NAME, not an email — the reader emits `owners[0].displayName`
                    # (or literally "Shared Drive"). The brain resolves the bare `author` string
                    # only as an email, which is why Drive items are unattributable and why the
                    # fix is an owner-enrichment pass, not a mapping tweak (docs/TODO.md).
                    "author": "Ada Lovelace",
                    "file path": "Team/Notes.docx",
                    "mime type": "application/vnd.google-apps.document",
                    "created at": "2026-07-01T00:00:00Z",
                    "modified at": "2026-07-20T09:00:00Z",
                },
            )
        ],
    )

    (doc,) = list(GoogleDriveSource(folder_id="fold-1").fetch())

    assert spy.load_kwargs == {"folder_id": "fold-1"}
    assert doc.source == "gdrive" and doc.external_id == "f1"
    assert doc.author == "Ada Lovelace"
    assert doc.authors is None  # no owner enrichment for Drive — the item is credited to nobody
    assert doc.source_ts == "2026-07-20T09:00:00Z"  # edit time beats creation time


def test_gdrive_service_account_key_is_only_passed_when_set(monkeypatch):
    """The reader defaults `service_account_key_path` to a literal `service_account_key.json`.
    Forwarding `None` would override that default with a value it cannot open, so an
    unconfigured connection must not send the kwarg at all."""
    spy = install(monkeypatch, "gdrive", FakeGoogleDriveReader, docs=[])
    list(GoogleDriveSource(file_ids=["f1"]).fetch())
    assert spy.init_kwargs == {}  # nothing passed at all — not `service_account_key_path=None`
    assert spy.load_kwargs == {"file_ids": ["f1"]}

    spy2 = install(monkeypatch, "gdrive", FakeGoogleDriveReader, docs=[])
    list(GoogleDriveSource(file_ids=["f1"], service_account_key_path="/k.json").fetch())
    assert spy2.init_kwargs["service_account_key_path"] == "/k.json"


def test_gdrive_requires_a_selection():
    with pytest.raises(ValueError):
        GoogleDriveSource()


# -- Confluence -----------------------------------------------------------------------------
def test_confluence_space_and_page_branches(monkeypatch):
    spy = install(
        monkeypatch,
        "confluence",
        FakeConfluenceReader,
        docs=[FakeDoc(text="page body", metadata={"page_id": "c1", "title": "Runbook"})],
    )

    (doc,) = list(ConfluenceSource(base_url="https://x.atlassian.net/wiki", space_key="ENG").fetch())

    # Exact, not subset: forwarding an extra kwarg would slip through a subset check, and
    # `cloud=None` in particular overrides the reader's `cloud=True` default and changes which
    # Atlassian API dialect the client speaks.
    assert spy.init_kwargs == {"base_url": "https://x.atlassian.net/wiki"}
    assert spy.load_kwargs == {"space_key": "ENG"}
    assert (doc.source, doc.external_id, doc.title) == ("confluence", "c1", "Runbook")

    spy2 = install(monkeypatch, "confluence", FakeConfluenceReader, docs=[])
    list(ConfluenceSource(base_url="https://x/wiki", page_ids=["c9"]).fetch())
    assert spy2.load_kwargs == {"page_ids": ["c9"]}


def test_confluence_requires_a_selection():
    with pytest.raises(ValueError):
        ConfluenceSource(base_url="https://x/wiki")


# -- shared -------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("module", "build"),
    [
        ("notion", lambda: NotionSource(token="t", page_ids=["p"])),
        ("gdrive", lambda: GoogleDriveSource(folder_id="f")),
        ("confluence", lambda: ConfluenceSource(base_url="https://x/wiki", space_key="S")),
    ],
)
def test_a_missing_extra_surfaces_as_the_install_hint(monkeypatch, module, build):
    """The extras are opt-in, so "reader not installed" is a normal operator state. It must
    reach them as the actionable MissingExtraError, not an ImportError from deep inside a
    generator — and because `fetch` is a generator, it only raises once iterated."""

    def raise_missing(*a, **kw):
        raise MissingExtraError(module, f"llama-index-readers-{module}")

    monkeypatch.setattr(f"aios_ingest.sources.{module}.lazy_reader", raise_missing)
    with pytest.raises(MissingExtraError, match=module):
        list(build().fetch())
