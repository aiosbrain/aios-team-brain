import asyncio
import dataclasses
import http.client
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from types import SimpleNamespace

import httpx
from aios_ingest.sources.gdrive_docs import extract_google_doc
import pytest

from aios_ingest.sources.gdrive import (
    GoogleDriveSource,
    IncompleteExtractionError,
    ProviderCursorInvalid,
    ProviderDeferred,
    _AbsoluteDeadlineHttp,
    _broker_authorized_http,
    _credential_authorized_http,
)
from aios_ingest.state import Channel, StateStore, StreamKey, verification_hash
from aios_ingest.config import BrainSettings, Connection
from aios_ingest.engine import IngestSummary
from aios_ingest.normalize import RawDoc
from aios_ingest.gdrive_sync import (
    _checkpoint_progress,
    _checkpoint_complete_if_clean,
    _configured_roots,
    _drain_pending,
    _finish_materialized_pages,
    _push_doc,
    _run_deadline_reached,
    _run_gdrive_stream_unlocked,
    read_change_page,
    run_gdrive_stream,
    scope_generation,
    _retry_deferred,
)
from aios_ingest.brain_client import (
    BrainDeferred, BrainError, GdriveExecution, GdriveTokenProvider, IngestResult,
)
from aios_ingest.sources.gdrive_watch import ConfiguredGoogleDriveWatchManager, GoogleDriveWatchManager


class _Request:
    def __init__(self, value):
        self.value = value

    def execute(self):
        return self.value


class _Files:
    def __init__(self, pages, metadata):
        self.pages = list(pages)
        self.metadata = metadata
        self.list_calls = []

    def list(self, **kwargs):
        self.list_calls.append(kwargs)
        return _Request(self.pages.pop(0))

    def get(self, **kwargs):
        return _Request(self.metadata[kwargs["fileId"]])


class _Drive:
    def __init__(self, pages, metadata):
        self.api = _Files(pages, metadata)

    def files(self):
        return self.api


class _Documents:
    def __init__(self, documents):
        self.documents = documents
        self.calls = []

    def get(self, **kwargs):
        self.calls.append(kwargs)
        return _Request(self.documents[kwargs["documentId"]])


class _Docs:
    def __init__(self, documents):
        self.api = _Documents(documents)

    def documents(self):
        return self.api


def _paragraph(text, *, link=None, heading=None, bullet=None):
    run = {"content": text}
    if link:
        run["textStyle"] = {"link": {"url": link}}
    p = {"elements": [{"textRun": run}]}
    if heading:
        p["paragraphStyle"] = {"namedStyleType": heading}
    if bullet is not None:
        p["bullet"] = {"nestingLevel": bullet}
    return {"paragraph": p}


def test_docs_extraction_preserves_nested_tabs_tables_links_footnotes_and_unicode():
    response = {
        "title": "Design",
        "tabs": [{
            "tabProperties": {"tabId": "root", "title": "Overview"},
            "documentTab": {
                "body": {"content": [
                    _paragraph("Résumé 東京\n", heading="HEADING_1"),
                    _paragraph("OpenAI\n", link="https://openai.com"),
                    {"table": {"tableRows": [
                        {"tableCells": [{"content": [_paragraph("Name\n")]}, {"content": [_paragraph("Value\n")]}]},
                        {"tableCells": [{"content": [_paragraph("α\n")]}, {"content": [_paragraph("β\n")]}]},
                    ]}},
                    {"paragraph": {"elements": [{"footnoteReference": {"footnoteId": "fn1"}}]}},
                ]},
                "footnotes": {"fn1": {"content": [_paragraph("Footnote text\n")]}}
            },
            "childTabs": [{
                "tabProperties": {"tabId": "child", "title": "Details", "parentTabId": "root", "nestingLevel": 1},
                "documentTab": {"body": {"content": [_paragraph("- not inferred\n", bullet=1)]}}
            }]
        }]
    }

    result = extract_google_doc(response)

    assert result.complete is True
    assert [t["id"] for t in result.tabs] == ["root", "child"]
    assert "# Résumé 東京" in result.text
    assert "[OpenAI](https://openai.com)" in result.text
    assert "| Name | Value |" in result.text and "| α | β |" in result.text
    assert "[^fn1]: Footnote text" in result.text
    assert "## Details" in result.text


def test_docs_extraction_marks_required_missing_content_and_limits_incomplete():
    missing = extract_google_doc({"tabs": [{"tabProperties": {"tabId": "x", "title": "X"}}]})
    assert missing.complete is False
    assert any(i.code == "missing_tab_content" and i.blocking for i in missing.issues)

    limited = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "x", "title": "X"},
        "documentTab": {"body": {"content": [_paragraph("abcdefghij")]}}
    }]}, max_chars=8)
    assert limited.complete is False
    assert any(i.code == "limit_exceeded" for i in limited.issues)


def test_docs_extraction_discloses_unsupported_complete_but_malformed_child_is_incomplete():
    unsupported = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [
            _paragraph("readable\n"), {"unsupportedWidget": {"id": "w1"}},
        ]}},
    }]})
    assert unsupported.complete is True
    assert any(i.code == "unsupported_element" and not i.blocking for i in unsupported.issues)

    malformed_child = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [_paragraph("root\n")]}},
        "childTabs": [{
            "tabProperties": {"tabId": "child", "title": "Child"},
            "documentTab": {"body": {"content": ["not-a-block"]}},
        }],
    }]})
    assert malformed_child.complete is False
    assert any(i.code == "malformed_block" and i.blocking for i in malformed_child.issues)


@pytest.mark.parametrize("supplied_tabs", [None, "tabs", {"bad": "shape"}, 7, [], [None]])
def test_supplied_malformed_tabs_fail_closed_without_legacy_body_fallback(supplied_tabs):
    result = extract_google_doc({
        "tabs": supplied_tabs,
        "body": {"content": [_paragraph("legacy body must not be accepted\n")]},
    })
    assert result.complete is False
    assert "legacy body must not be accepted" not in result.text
    assert any(issue.blocking and issue.location.startswith("document/tabs") for issue in result.issues)


@pytest.mark.parametrize("children", [None, "children", {"bad": "shape"}, 3, [None]])
def test_present_malformed_child_tabs_are_location_aware_and_blocking(children):
    result = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [_paragraph("known root\n")]}},
        "childTabs": children,
    }]})
    assert result.complete is False
    assert any(issue.blocking and "document/tabs/0/childTabs" in issue.location
               for issue in result.issues)


def test_absent_optional_child_tabs_and_valid_root_remain_complete():
    result = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [_paragraph("complete\n")]}},
    }]})
    assert result.complete is True
    assert result.text.endswith("complete")


@pytest.mark.parametrize("payload", [None, [], "text", 7])
def test_recognized_text_run_requires_an_object_with_exact_location(payload):
    result = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [{"paragraph": {"elements": [
            {"textRun": {"content": "valid text\n"}},
            {"textRun": payload},
        ]}}]}},
    }]})
    assert "valid text" in result.text
    assert result.complete is False
    assert any(
        issue.code == "malformed_text_run"
        and issue.location.endswith("/block:0/inline:1/textRun")
        and issue.blocking
        for issue in result.issues
    )


@pytest.mark.parametrize("text_run", [{}, {"content": None}, {"content": []}, {"content": 7}])
def test_recognized_text_run_requires_string_content(text_run):
    result = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [{"paragraph": {"elements": [
            {"textRun": {"content": "valid text\n"}},
            {"textRun": text_run},
        ]}}]}},
    }]})
    assert "valid text" in result.text
    assert result.complete is False
    assert any(
        issue.code == "malformed_text"
        and issue.location.endswith("/block:0/inline:1/textRun/content")
        and issue.blocking
        for issue in result.issues
    )


@pytest.mark.parametrize("payload", [None, [], "reference", 7])
def test_recognized_footnote_reference_requires_an_object(payload):
    result = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [{"paragraph": {"elements": [
            {"textRun": {"content": "valid text\n"}},
            {"footnoteReference": payload},
        ]}}]}},
    }]})
    assert "valid text" in result.text
    assert result.complete is False
    assert any(
        issue.code == "malformed_footnote_reference"
        and issue.location.endswith("/block:0/inline:1/footnoteReference")
        and issue.blocking
        for issue in result.issues
    )


@pytest.mark.parametrize(
    "reference", [{}, {"footnoteId": None}, {"footnoteId": []}, {"footnoteId": 7}, {"footnoteId": ""}],
)
def test_recognized_footnote_reference_requires_nonempty_string_id(reference):
    result = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [{"paragraph": {"elements": [
            {"textRun": {"content": "valid text\n"}},
            {"footnoteReference": reference},
        ]}}]}},
    }]})
    assert "valid text" in result.text
    assert result.complete is False
    assert any(
        issue.code == "malformed_footnote_id"
        and issue.location.endswith("/block:0/inline:1/footnoteReference/footnoteId")
        and issue.blocking
        for issue in result.issues
    )


def test_unrecognized_inline_remains_disclosed_but_nonblocking():
    result = extract_google_doc({"tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [{"paragraph": {"elements": [
            {"textRun": {"content": "valid text\n"}},
            {"futureInlineWidget": {"id": "widget-1"}},
        ]}}]}},
    }]})
    assert result.complete is True
    assert "valid text" in result.text
    assert any(
        issue.code == "unsupported_inline" and not issue.blocking
        and issue.location.endswith("/block:0/inline:1")
        for issue in result.issues
    )


@pytest.mark.parametrize("tab", [
    {"tabProperties": None, "documentTab": {"body": {"content": [_paragraph("x")]}}},
    {"tabProperties": {"tabId": "root"}, "documentTab": None},
    {"tabProperties": {"tabId": "root"}, "documentTab": {"body": None}},
    {"tabProperties": {"tabId": "root"}, "documentTab": {"body": {"content": None}}},
    {"tabProperties": {"tabId": "root"}, "documentTab": {
        "body": {"content": [_paragraph("x")]}, "footnotes": "bad",
    }},
])
def test_supplied_tab_containers_are_validated_without_exceptions(tab):
    result = extract_google_doc({"tabs": [tab]})
    assert result.complete is False
    assert any(issue.blocking and "document/tabs/0" in issue.location for issue in result.issues)


def test_direct_source_refuses_to_emit_an_incomplete_document():
    drive = _Drive([], {
        "doc1": {
            "id": "doc1",
            "name": "Incomplete",
            "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-09-01T01:02:03Z",
        }
    })
    docs = _Docs({"doc1": {"title": "Incomplete", "tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"}
    }]}})

    source = GoogleDriveSource(
        file_ids=["doc1"],
        api_mode="docs",
        _drive_service=drive,
        _docs_service=docs,
    )
    with pytest.raises(IncompleteExtractionError, match="missing_tab_content"):
        list(source.fetch())


def test_direct_source_refuses_malformed_recognized_inline_while_preserving_valid_text_diagnostic():
    drive = _Drive([], {
        "doc1": {
            "id": "doc1", "name": "Malformed Inline",
            "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-09-01T01:02:03Z",
        },
    })
    docs = _Docs({"doc1": {"title": "Malformed Inline", "tabs": [{
        "tabProperties": {"tabId": "root", "title": "Root"},
        "documentTab": {"body": {"content": [{"paragraph": {"elements": [
            {"textRun": {"content": "known complete prefix\n"}},
            {"footnoteReference": {"footnoteId": None}},
        ]}}]}},
    }]}})
    source = GoogleDriveSource(
        file_ids=["doc1"], api_mode="docs", _drive_service=drive, _docs_service=docs,
    )
    with pytest.raises(IncompleteExtractionError, match="malformed_footnote_id") as raised:
        list(source.fetch())
    assert "inline:1/footnoteReference/footnoteId" in str(raised.value)


def test_direct_source_paginates_recursive_selection_dedupes_and_requests_tab_content():
    drive = _Drive(
        pages=[
            {"files": [{"id": "doc1", "mimeType": "application/vnd.google-apps.document"}], "nextPageToken": "p2"},
            {"files": [{"id": "folder2", "mimeType": "application/vnd.google-apps.folder"}, {"id": "doc1", "mimeType": "application/vnd.google-apps.document"}]},
            {"files": [{"id": "doc2", "mimeType": "application/vnd.google-apps.document"}]},
        ],
        metadata={
            "doc1": {"id": "doc1", "name": "One", "mimeType": "application/vnd.google-apps.document", "modifiedTime": "2026-09-01T01:02:03Z", "owners": [{"permissionId": "perm-a", "emailAddress": "a@example.com"}]},
            "doc2": {"id": "doc2", "name": "Two", "mimeType": "application/vnd.google-apps.document", "modifiedTime": "2026-09-02T01:02:03Z", "lastModifyingUser": {"permissionId": "perm-b", "emailAddress": "b@example.com"}},
        },
    )
    doc_payload = lambda title: {"title": title, "tabs": [{"tabProperties": {"tabId": "root", "title": title}, "documentTab": {"body": {"content": [_paragraph(f"{title} body\n")]}}}]}
    docs = _Docs({"doc1": doc_payload("One"), "doc2": doc_payload("Two")})

    result = list(GoogleDriveSource(folder_id="root", api_mode="docs", recursive=True,
                                    _drive_service=drive, _docs_service=docs).fetch())

    assert [d.external_id for d in result] == ["doc1", "doc2"]
    assert all(call["includeTabsContent"] is True for call in docs.api.calls)
    assert result[0].authors is None
    assert result[0].extra_frontmatter["gdrive_source_identities"] == [
        {"role": "owner", "provider": "gdrive", "external_id": "permission:perm-a", "email": "a@example.com"}
    ]
    assert result[0].extra_frontmatter["attribution_diagnostics"][0]["code"] == "owner_not_authorship"
    assert result[1].authors[0]["role"] == "editor"
    assert drive.api.list_calls[1]["pageToken"] == "p2"


def test_service_account_and_owner_metadata_never_become_human_authorship_or_work():
    drive = _Drive([], {
        "doc1": {
            "id": "doc1", "name": "Automated", "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-09-01T01:02:03Z",
            "owners": [{"permissionId": "owner", "emailAddress": "owner@example.com"}],
            "lastModifyingUser": {
                "permissionId": "robot", "emailAddress": "sync@project.iam.gserviceaccount.com",
            },
        },
    })
    docs = _Docs({"doc1": {
        "title": "Automated", "tabs": [{
            "tabProperties": {"tabId": "root", "title": "Root"},
            "documentTab": {"body": {"content": [_paragraph("body\n")]}},
        }],
    }})
    doc = next(iter(GoogleDriveSource(
        file_ids=["doc1"], api_mode="docs", _drive_service=drive, _docs_service=docs,
    ).fetch()))
    assert doc.authors is None
    assert doc.extra_frontmatter["contributions"] == []
    assert {row["code"] for row in doc.extra_frontmatter["attribution_diagnostics"]} >= {
        "owner_not_authorship", "service_account_not_authorship",
    }


def test_provider_authority_is_checked_between_metadata_and_docs_reads():
    calls = []

    def gate():
        calls.append("gate")
        if len(calls) == 2:
            raise BrainError(409, "connection_unavailable", "paused")

    drive = _Drive([], {
        "doc1": {
            "id": "doc1", "name": "One",
            "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-09-01T01:02:03Z",
        },
    })
    docs = _Docs({"doc1": {"title": "must-not-be-read"}})
    source = GoogleDriveSource(
        file_ids=["doc1"], api_mode="docs", provider_gate=gate,
        _drive_service=drive, _docs_service=docs,
    )

    meta = source._metadata("doc1")
    with pytest.raises(BrainError, match="connection_unavailable"):
        source._raw_doc(meta)
    assert docs.api.calls == []


def test_provider_authority_is_checked_before_each_pagination_request():
    calls = []

    def gate():
        calls.append("gate")
        if len(calls) == 2:
            raise BrainError(409, "stale_execution", "replaced")

    drive = _Drive([
        {"files": [{"id": "doc1", "mimeType": "application/vnd.google-apps.document"}],
         "nextPageToken": "next"},
        {"files": [{"id": "doc2", "mimeType": "application/vnd.google-apps.document"}]},
    ], {})
    source = GoogleDriveSource(
        folder_id="root", api_mode="docs", provider_gate=gate,
        _drive_service=drive, _docs_service=_Docs({}),
    )

    with pytest.raises(BrainError, match="stale_execution"):
        list(source._selected_files())
    assert len(drive.api.list_calls) == 1
    assert drive.api.list_calls[0]["pageToken"] is None


def test_brokered_token_provider_refreshes_before_margin_and_updates_bound_credentials():
    now = 1_800_000_000.0
    execution = GdriveExecution(
        "11111111-1111-1111-1111-111111111111", 7, 3,
        "22222222-2222-2222-2222-222222222222", "later", "scope",
        {
            "authenticatedAccountId": "subject:account",
            "authenticatedAccount": "docs@example.com",
            "scopeSet": ["drive", "docs"],
        },
    )
    iso = lambda seconds: datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
    provider = GdriveTokenProvider(
        "http://brain", {"Authorization": "Bearer connector"}, execution,
        {
            "access_token": "initial", "expires_at": iso(now + 30),
            "scopes": ["drive", "docs"],
            "account": {"subject": "subject:account", "email": "docs@example.com"},
        },
        refresh_margin_seconds=60, now_fn=lambda: now,
    )
    requests = []

    def handler(request: httpx.Request):
        requests.append(request)
        return httpx.Response(200, json={
            "access_token": "replacement", "expires_at": iso(now + 3600),
            "scopes": ["docs", "drive"],
            "account": {"subject": "subject:account", "email": "docs@example.com"},
        })

    provider._client.close()
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))

    class Credential:
        token = ""

    credential = Credential()
    provider.bind(credential)
    assert provider.access_token == "replacement"
    assert credential.token == "replacement"
    assert len(requests) == 1
    body = requests[0].content.decode()
    assert "refresh" not in body and "client_secret" not in body
    provider.close()


@pytest.mark.parametrize("failure", ["pause", "revocation", "account", "scopes", "broker"])
def test_brokered_token_replacement_fails_closed(failure):
    now = 1_800_000_000.0
    iso = lambda seconds: datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
    execution = GdriveExecution(
        "11111111-1111-1111-1111-111111111111", 7, 3,
        "22222222-2222-2222-2222-222222222222", "later", "scope",
        {
            "authenticatedAccountId": "subject:account",
            "authenticatedAccount": "docs@example.com",
            "scopeSet": ["drive", "docs"],
        },
    )
    provider = GdriveTokenProvider(
        "http://brain", {}, execution,
        {
            "access_token": "initial", "expires_at": iso(now + 1),
            "scopes": ["drive", "docs"],
            "account": {"subject": "subject:account", "email": "docs@example.com"},
        }, now_fn=lambda: now,
    )

    def handler(_request: httpx.Request):
        if failure == "pause":
            return httpx.Response(409, json={"error": {"code": "stale_execution", "message": "paused"}})
        if failure == "broker":
            return httpx.Response(503, json={"error": {"code": "provider_unavailable", "message": "down"}})
        if failure == "revocation":
            return httpx.Response(401, json={"error": {"code": "unauthorized", "message": "revoked"}})
        return httpx.Response(200, json={
            "access_token": "replacement", "expires_at": iso(now + 3600),
            "scopes": ["drive"] if failure == "scopes" else ["drive", "docs"],
            "account": {
                "subject": "subject:other" if failure == "account" else "subject:account",
                "email": "docs@example.com",
            },
        })

    provider._client.close()
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))
    with pytest.raises(BrainError) as exc:
        provider.ensure_valid()
    assert exc.value.code == (
        "credential_mismatch" if failure in {"account", "scopes"}
        else "stale_execution" if failure == "pause"
        else "unauthorized" if failure == "revocation"
        else "provider_unavailable"
    )
    provider.close()


def test_unexpected_401_gets_one_brokered_replacement_then_is_terminal():
    class Unauthorized(Exception):
        def __init__(self):
            self.resp = type("Response", (), {"status": 401})()

    class Provider:
        refreshes = 0
        def ensure_valid(self): pass
        def force_refresh(self): self.refreshes += 1

    class Request:
        def __init__(self, persistent=False):
            self.calls = 0
            self.persistent = persistent
        def execute(self):
            self.calls += 1
            if self.calls == 1 or self.persistent:
                raise Unauthorized()
            return {"id": "doc", "name": "Doc", "modifiedTime": "2026-01-01T00:00:00Z"}

    class Files:
        def __init__(self, request): self.request = request
        def get(self, **kwargs): return self.request

    class Drive:
        def __init__(self, request): self._files = Files(request)
        def files(self): return self._files

    provider = Provider()
    recovered = Request()
    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", token_provider=provider,
        _drive_service=Drive(recovered), _docs_service=_Docs({}),
    )
    assert source._metadata("doc")["id"] == "doc"
    assert recovered.calls == 2 and provider.refreshes == 1

    persistent = Request(persistent=True)
    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", token_provider=provider,
        _drive_service=Drive(persistent), _docs_service=_Docs({}),
    )
    with pytest.raises(BrainError) as exc:
        source._metadata("doc")
    assert exc.value.code == "provider_unauthorized"
    assert persistent.calls == 2


def _real_google_transport(
    provider,
    responses,
    uri="https://www.googleapis.com/drive/v3/files/doc",
):
    """Use googleapiclient + google_auth_httplib2 over a deterministic fake HTTP socket."""
    httplib2 = pytest.importorskip("httplib2")
    Credentials = pytest.importorskip("google.oauth2.credentials").Credentials
    HttpRequest = pytest.importorskip("googleapiclient.http").HttpRequest
    authorizations = []

    class Http:
        def request(self, uri, method="GET", body=None, headers=None, **_kwargs):
            header_map = headers or {}
            authorizations.append(next(
                (value for key, value in header_map.items() if key.lower() == "authorization"),
                None,
            ))
            response = responses.pop(0)
            if isinstance(response, Exception):
                raise response
            status, payload = response
            return httplib2.Response({
                "status": str(status),
                "reason": "OK" if status < 400 else "Unauthorized",
                "content-type": "application/json",
            }), json.dumps(payload).encode()

    credentials = Credentials(token=provider.access_token, scopes=provider.scopes)
    provider.bind(credentials)
    transport = _broker_authorized_http(credentials, Http())
    request = HttpRequest(
        transport,
        lambda _response, content: json.loads(content.decode()),
        uri,
    )
    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", token_provider=provider,
        _drive_service=object(), _docs_service=object(),
    )
    return source, request, authorizations


def _transport_token_provider(*, broker_status=200):
    now = 1_800_000_000.0
    expires = lambda seconds: datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()
    execution = GdriveExecution(
        "11111111-1111-1111-1111-111111111111", 7, 3,
        "22222222-2222-2222-2222-222222222222", "later", "scope",
        {
            "authenticatedAccountId": "subject:account",
            "authenticatedAccount": "docs@example.com",
            "scopeSet": ["drive", "docs"],
        },
    )
    provider = GdriveTokenProvider(
        "http://brain", {}, execution,
        {
            "access_token": "initial", "expires_at": expires(now + 3600),
            "scopes": ["drive", "docs"],
            "account": {"subject": "subject:account", "email": "docs@example.com"},
        }, now_fn=lambda: now,
    )
    broker_requests = []

    def handler(request: httpx.Request):
        broker_requests.append(request)
        if broker_status != 200:
            return httpx.Response(
                broker_status,
                json={"error": {"code": "unauthorized", "message": "revoked"}},
            )
        return httpx.Response(200, json={
            "access_token": "replacement", "expires_at": expires(now + 7200),
            "scopes": ["drive", "docs"],
            "account": {"subject": "subject:account", "email": "docs@example.com"},
        })

    provider._client.close()
    provider._client = httpx.Client(transport=httpx.MockTransport(handler))
    return provider, broker_requests


@pytest.mark.parametrize("uri", [
    "https://www.googleapis.com/drive/v3/files/doc",
    "https://docs.googleapis.com/v1/documents/doc",
])
def test_real_google_transport_401_uses_one_broker_replacement_and_updated_authorization(uri):
    provider, broker_requests = _transport_token_provider()
    source, request, authorizations = _real_google_transport(provider, [
        (401, {"error": {"message": "expired"}}),
        (200, {"id": "doc"}),
    ], uri)

    assert source._execute(request) == {"id": "doc"}
    assert authorizations == ["Bearer initial", "Bearer replacement"]
    assert len(broker_requests) == 1
    provider.close()


def test_real_google_transport_persistent_401_is_terminal_after_one_replacement():
    provider, broker_requests = _transport_token_provider()
    source, request, authorizations = _real_google_transport(provider, [
        (401, {"error": {"message": "expired"}}),
        (401, {"error": {"message": "still unauthorized"}}),
    ])

    with pytest.raises(BrainError) as exc:
        source._execute(request)
    assert exc.value.code == "provider_unauthorized"
    assert authorizations == ["Bearer initial", "Bearer replacement"]
    assert len(broker_requests) == 1
    provider.close()


def test_real_google_transport_revocation_during_replacement_is_terminal():
    provider, broker_requests = _transport_token_provider(broker_status=401)
    source, request, authorizations = _real_google_transport(provider, [
        (401, {"error": {"message": "expired"}}),
    ])

    with pytest.raises(BrainError) as exc:
        source._execute(request)
    assert exc.value.code == "unauthorized"
    assert authorizations == ["Bearer initial"]
    assert len(broker_requests) == 1
    provider.close()


def test_real_google_transport_unrelated_error_is_not_classified_as_refreshable():
    provider, broker_requests = _transport_token_provider()
    source, request, authorizations = _real_google_transport(provider, [OSError("socket failed")])

    with pytest.raises(OSError, match="socket failed"):
        source._execute(request)
    assert authorizations == ["Bearer initial"]
    assert broker_requests == []
    provider.close()


@pytest.mark.parametrize("drive_id", ["shared-a", "shared-b", "my-drive"])
def test_watch_preserves_authoritative_token_drive_pair(drive_id):
    seen = []

    class Changes:
        def watch(self, **kwargs):
            seen.append(kwargs)
            return _Request({"id": f"channel-{drive_id}", "resourceId": "resource"})

    class Service:
        def changes(self): return Changes()

    manager = GoogleDriveWatchManager(
        webhook_url="https://example.test/watch", page_token="fallback",
        drive_id=drive_id,
    )
    manager._service = lambda: Service()
    channel = Channel("gd", "old", "old-resource", None, "namespace")
    manager.renew(channel, "authoritative-token", drive_id)

    assert seen[0]["pageToken"] == "authoritative-token"
    if drive_id == "my-drive":
        assert "driveId" not in seen[0]
    else:
        assert seen[0]["driveId"] == drive_id
        assert seen[0]["supportsAllDrives"] is True


def test_configured_watch_router_forwards_authoritative_drive_id(monkeypatch):
    seen = []

    class Manager:
        def __init__(self, **kwargs):
            seen.append(("init", kwargs["drive_id"], kwargs["page_token"]))
        def renew(self, channel, page_token=None, drive_id=None):
            seen.append(("renew", drive_id, page_token))
            return channel

    monkeypatch.setattr("aios_ingest.sources.gdrive_watch.GoogleDriveWatchManager", Manager)
    router = ConfiguredGoogleDriveWatchManager([
        Connection("gd", "gdrive", options={"webhook_url": "https://example.test/watch"}),
    ])
    channel = Channel("gd", "old", "resource", None, "namespace")
    router.renew(channel, "cursor", "access", None, "shared-drive")

    assert seen == [
        ("init", "shared-drive", "cursor"),
        ("renew", "shared-drive", "cursor"),
    ]


def test_namespaced_progress_pending_ack_and_validated_overlapping_channels(tmp_path):
    store = StateStore(str(tmp_path / "state.sqlite"))
    key = StreamKey("team-a", "connection-id", "credential-id", "shared-drive-1")
    progress = store.begin_generation(key, 4, start_token="opaque/start+token==")
    assert progress.baseline_start_token == "opaque/start+token=="
    assert key.namespace(4) != StreamKey("team-b", "connection-id", "credential-id", "shared-drive-1").namespace(4)

    store.enqueue_work(progress.namespace, 4, "doc1", "upsert", {"page": "opaque/page"})
    store.update_progress(progress.namespace, traversal_token="opaque/page")
    (work,) = store.list_pending(progress.namespace, 4)
    assert store.pending_count(progress.namespace, 4) == 1
    store.ack_work(work)
    assert store.pending_count(progress.namespace, 4) == 0

    token = "verify-me"
    old = Channel("gd", "old", "resource", "2099-01-01T00:00:00Z", progress.namespace, verification_hash(token))
    new = Channel("gd", "new", "resource-new", "2099-01-02T00:00:00Z", progress.namespace, verification_hash(token))
    store.save_channel(old)
    store.save_channel(new)
    assert len(store.list_channels("gd")) == 2
    assert store.validate_notification(channel_id="old", resource_id="resource", verification_token=token) == old
    assert store.validate_notification(channel_id="old", resource_id="wrong", verification_token=token) is None
    assert store.validate_notification(channel_id="old", resource_id="resource", verification_token="wrong") is None

    lease = store.acquire_lease(progress.namespace, ttl_seconds=60)
    assert lease is not None
    owner, fence = lease
    assert store.acquire_lease(progress.namespace, ttl_seconds=60) is None
    assert store.renew_lease(progress.namespace, owner, fence, ttl_seconds=60) is True
    assert store.renew_lease(progress.namespace, "stale-owner", fence, ttl_seconds=60) is False
    store.release_lease(progress.namespace, owner, fence)
    replacement = store.acquire_lease(progress.namespace, ttl_seconds=60)
    assert replacement is not None and replacement[1] > fence
    store.close()


def test_change_page_keeps_opaque_tokens_and_uses_new_start_only_at_terminal_boundary():
    class Changes:
        def __init__(self):
            self.kwargs = None
        def list(self, **kwargs):
            self.kwargs = kwargs
            return _Request({
                "changes": [{"fileId": "doc1", "removed": False}],
                "nextPageToken": "opaque/next+token==",
                "newStartPageToken": None,
            })
    class Drive:
        def __init__(self):
            self.api = Changes()
        def changes(self):
            return self.api

    drive = Drive()
    page = read_change_page(drive, "opaque/start+token==", "shared-drive")
    assert page.next_page_token == "opaque/next+token=="
    assert page.new_start_page_token is None
    assert drive.api.kwargs["pageToken"] == "opaque/start+token=="
    assert drive.api.kwargs["driveId"] == "shared-drive"
    assert "changeType" in drive.api.kwargs["fields"]
    assert "driveId" in drive.api.kwargs["fields"]
    assert scope_generation({"file_ids": ["A"]}) != scope_generation({"file_ids": ["B"]})


@pytest.mark.asyncio
async def test_no_file_shared_drive_tombstone_durably_blocks_cursor_for_recovery(tmp_path):
    path = tmp_path / "drive-tombstone.sqlite"
    state = StateStore(str(path))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account", "drive-a"), 9,
        start_token="start", phase="current",
    )
    snapshot = state.begin_selection_snapshot(
        progress.namespace, 9, [
            ("drive-a", "drive", "drive-a", True),
            ("overlap", "file", "drive-a", False),
        ],
    )
    state.complete_traversal(
        progress.namespace, 9, "drive-a", "drive-a", None, snapshot_id=snapshot,
    )
    state.publish_selection_snapshot(progress.namespace, 9, snapshot)
    state.record_membership(
        progress.namespace, 9, "descendant", "drive-a", "drive-a", snapshot_id=snapshot,
    )
    state.record_membership(
        progress.namespace, 9, "overlap", "drive-a", "drive-a", snapshot_id=snapshot,
    )
    state.record_membership(
        progress.namespace, 9, "overlap", "overlap", "drive-a", snapshot_id=snapshot,
    )
    state.update_progress(progress.namespace, listing_complete=True, page_token="cursor")

    class Changes:
        def list(self, **_kwargs):
            return _Request({
                "changes": [{"changeType": "drive", "driveId": "drive-a", "removed": True}],
                "newStartPageToken": "terminal",
            })

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()

    class Client:
        revision = 0
        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": payload}

    result = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=Client(), execution=GdriveExecution("connection", 9, 1, "owner", "later", "scope", {}),
        options={"credential_identity": "account", "selection_state": "selected", "shared_drive_ids": ["drive-a"]},
        source=Source(), drive=Drive(), generation=9, drive_id="drive-a",
        namespace=progress.namespace, max_work=0, discovery_budget=1, retry_budget=0,
    )
    page = state.next_uncommitted_page(progress.namespace, 9)
    assert result.failed == 0
    assert page is not None and page.rescan_snapshot_id is not None
    assert state.membership_ids(progress.namespace, 9, snapshot_id=snapshot) == ["overlap"]
    pending = state.list_pending(progress.namespace, 9, limit=10)
    assert [(work.item_key, work.action) for work in pending] == [("descendant", "remove")]
    assert state.get_progress(progress.namespace).page_token == "cursor"
    state.close()

    restarted = StateStore(str(path))
    replay = restarted.next_uncommitted_page(progress.namespace, 9)
    assert replay is not None and replay.rescan_snapshot_id == page.rescan_snapshot_id
    assert restarted.membership_ids(progress.namespace, 9, snapshot_id=snapshot) == ["overlap"]
    assert [(work.item_key, work.action) for work in restarted.list_pending(progress.namespace, 9, limit=10)] == [
        ("descendant", "remove"),
    ]
    restarted.close()


@pytest.mark.asyncio
async def test_nested_folder_tombstone_uses_transitive_membership_provenance(tmp_path):
    state = StateStore(str(tmp_path / "ancestor-tombstone.sqlite"))
    progress = state.begin_generation(StreamKey("team", "connection", "account"), 4,
                                      start_token="start", phase="current")
    snapshot = state.begin_selection_snapshot(
        progress.namespace, 4, [("root-folder", "folder", "my-drive", True)],
    )
    root_page = state.materialize_page(
        progress.namespace, 4, "root-list", "baseline", None, None, None, [],
        snapshot_id=snapshot,
        traversal_additions=[("root-folder", "nested", "my-drive", None)],
        traversal_completion=("root-folder", "root-folder", None),
    )
    state.commit_page(progress.namespace, 4, root_page.page_id, require_acks=False)
    child_page = state.materialize_page(
        progress.namespace, 4, "child-list", "baseline", None, None, None, [],
        snapshot_id=snapshot,
        membership_additions=[("nested-doc", "root-folder", "my-drive", "nested")],
        traversal_completion=("root-folder", "nested", None),
    )
    state.commit_page(progress.namespace, 4, child_page.page_id, require_acks=False)
    state.publish_selection_snapshot(progress.namespace, 4, snapshot)
    state.update_progress(progress.namespace, listing_complete=True, page_token="cursor")

    class Changes:
        def list(self, **_kwargs):
            return _Request({
                "changes": [{"changeType": "file", "fileId": "nested", "removed": True}],
                "newStartPageToken": "terminal",
            })

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()

    class Client:
        revision = 0
        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": payload}

    await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=Client(), execution=GdriveExecution("connection", 4, 1, "owner", "later", "scope", {}),
        options={"credential_identity": "account", "selection_state": "selected", "folder_ids": ["root-folder"]},
        source=Source(), drive=Drive(), generation=4, drive_id="my-drive",
        namespace=progress.namespace, max_work=0, discovery_budget=1, retry_budget=0,
    )
    assert state.membership_ids(progress.namespace, 4, snapshot_id=snapshot) == []
    assert [(work.item_key, work.action) for work in state.list_pending(progress.namespace, 4, limit=10)] == [
        ("nested-doc", "remove"),
    ]
    assert state.get_progress(progress.namespace).page_token == "cursor"
    state.close()


@pytest.mark.asyncio
async def test_each_scheduler_run_rebuilds_connection_from_latest_acquired_config(tmp_path, monkeypatch):
    integration_id = "00000000-0000-0000-0000-000000000001"
    configs = [
        {
            "authMode": "oauth", "fileIds": ["current"], "folderIds": [],
            "sharedDriveIds": [], "selectionState": "selected", "projectSlug": "current-project",
            "access": "external", "authenticatedAccountId": "account",
        },
        {
            "authMode": "oauth", "fileIds": [], "folderIds": [],
            "sharedDriveIds": [], "selectionState": "empty", "authenticatedAccountId": "account",
        },
    ]
    captured = []
    reconciled = []

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def acquire_gdrive_execution(self, requested, requested_owner):
            config = configs.pop(0)
            return GdriveExecution(requested, 3, 2, requested_owner, "later", "scope", config)
        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory-only", "account": {"subject": "account"}}
        def gdrive_token_provider(self, execution, grant):
            class Provider:
                def close(self): pass
            return Provider()
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def release_gdrive_execution(self, execution): pass
        async def checkpoint_gdrive_execution(self, execution, progress):
            return {"progress_revision": 1, "progress": progress}
        async def reconcile_gdrive(self, execution, **kwargs):
            reconciled.append(kwargs)
            return {"items": 0}

    class Source:
        def __init__(self, **kwargs): self.kwargs = kwargs
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id): return {"id": file_id}
        def _services(self):
            class Changes:
                def getStartPageToken(self, **kwargs): return _Request({"startPageToken": "start"})
            class Drive:
                def changes(self): return Changes()
            return Drive(), object()

    async def capture(_settings, effective, _state, **kwargs):
        captured.append((effective, kwargs["options"]))
        return IngestSummary(effective.name, failure_categories={})

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", capture)
    local = Connection(
        "docs", "gdrive", project="legacy-project", access="team",
        options={
            "integration_id": integration_id, "folder_id": "legacy-folder",
            "service_account_key_path": "/leftover/key.json",
        },
    )
    settings = BrainSettings(base_url="http://brain", api_key="aios_a_b", team="demo")
    state = StateStore(str(tmp_path / "reconfigured.sqlite"))

    await run_gdrive_stream(settings, local, state)
    await run_gdrive_stream(settings, local, state)

    assert captured[0][0].project == "current-project"
    assert captured[0][0].access == "external"
    assert captured[0][1]["file_ids"] == ["current"]
    assert "folder_id" not in captured[0][1]
    assert "service_account_key_path" not in captured[0][1]
    assert len(captured) == 1
    assert reconciled == [{
        "complete_snapshot_ids": [],
        "reason": "complete empty gdrive scope generation 3",
    }]
    state.close()


@pytest.mark.asyncio
async def test_explicit_service_account_mode_never_uses_broker_and_requires_compatible_local_material(
    tmp_path, monkeypatch,
):
    integration_id = "00000000-0000-0000-0000-000000000001"
    config = {
        "authMode": "service_account", "fileIds": ["doc"], "folderIds": [],
        "sharedDriveIds": [], "selectionState": "selected", "serviceAccountStatus": "pending",
    }
    captured = []

    class Client:
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 1, 1, owner, "later", "scope", config)
        async def broker_gdrive_access_token(self, execution):
            raise AssertionError("service-account mode must not call the OAuth broker")
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def release_gdrive_execution(self, execution): pass
        async def checkpoint_gdrive_execution(self, execution, progress):
            return {"progress_revision": 1, "progress": progress}
        async def verify_gdrive_service_account(self, execution, identity):
            captured.append(("verified", identity))

    class Source:
        def __init__(self, **kwargs): self.kwargs = kwargs
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id): return {"id": file_id}
        def _services(self):
            class Changes:
                def getStartPageToken(self, **kwargs): return _Request({"startPageToken": "start"})
            class Drive:
                def changes(self): return Changes()
                def about(self):
                    class About:
                        def get(self, **kwargs):
                            return _Request({"user": {"emailAddress": "svc@example.com"}})
                    return About()
            return Drive(), object()

    async def capture(_settings, _connection, _state, **kwargs):
        captured.append(kwargs["options"])
        return IngestSummary("docs", failure_categories={})

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", capture)
    settings = BrainSettings(base_url="http://brain", api_key="aios_a_b", team="demo")
    state = StateStore(str(tmp_path / "service-account.sqlite"))

    missing = await run_gdrive_stream(
        settings, Connection("docs", "gdrive", options={"integration_id": integration_id}), state,
    )
    assert missing.failure_categories == {"service_account_credentials_missing": 1}

    valid = await run_gdrive_stream(settings, Connection(
        "docs", "gdrive",
        options={"integration_id": integration_id, "service_account_key_path": "/local/key.json"},
    ), state)
    assert valid.failed == 0
    assert captured[0] == ("verified", "svc@example.com")
    assert captured[1]["service_account_key_path"] == "/local/key.json"
    assert captured[1]["auth_mode"] == "service_account"
    state.close()


def test_provider_tombstone_is_acknowledged_only_after_shared_reconcile(tmp_path):
    store = StateStore(str(tmp_path / "remove.sqlite"))
    progress = store.begin_generation(StreamKey("team", "connection", "credential"), 1, start_token="opaque")
    store.enqueue_work(progress.namespace, 1, "DocA", "remove", {"file_id": "DocA"})

    class Client:
        calls = []

        async def reconcile_gdrive(self, connection_id, **kwargs):
            self.calls.append((connection_id, kwargs))
            return {"items": 1}

    summary = IngestSummary("connection", failure_categories={})
    execution = GdriveExecution("00000000-0000-0000-0000-000000000001", 1, 1,
                                "00000000-0000-0000-0000-000000000002", "later", "hash", {})
    asyncio.run(_drain_pending(
        Client(), execution, object(), Connection("connection", "gdrive"), store,
        progress.namespace, 1, summary, 10,
    ))
    assert summary.removed == 1
    assert store.pending_count(progress.namespace, 1) == 0
    assert Client.calls[0][1]["removed_provider_ids"] == ["DocA"]
    store.close()


def test_provider_tombstone_cleanup_failure_stays_durable_across_restart(tmp_path):
    path = tmp_path / "remove-retry.sqlite"
    store = StateStore(str(path))
    progress = store.begin_generation(StreamKey("team", "connection", "credential"), 1, start_token="opaque")
    store.enqueue_work(progress.namespace, 1, "DocA", "remove", {"file_id": "DocA"})

    class Client:
        async def reconcile_gdrive(self, *_args, **_kwargs):
            raise BrainError(503, "cleanup_unavailable", "retry")

    summary = IngestSummary("connection", failure_categories={})
    execution = GdriveExecution("00000000-0000-0000-0000-000000000001", 1, 1,
                                "00000000-0000-0000-0000-000000000002", "later", "hash", {})
    asyncio.run(_drain_pending(
        Client(), execution, object(), Connection("connection", "gdrive"), store,
        progress.namespace, 1, summary, 10,
    ))
    assert summary.failure_categories == {"cleanup_unavailable": 1}
    assert store.pending_count(progress.namespace, 1) == 1
    store.close()

    restarted = StateStore(str(path))
    assert restarted.pending_count(progress.namespace, 1) == 1
    restarted.close()


def test_notification_hint_never_becomes_a_provider_file_read(tmp_path):
    store = StateStore(str(tmp_path / "hint.sqlite"))
    progress = store.begin_generation(StreamKey("team", "connection", "credential"), 1, start_token="opaque")
    store.enqueue_work(progress.namespace, 1, "notification:channel:4", "poll", {})

    class Source:
        def _metadata(self, _):
            raise AssertionError("a notification hint must not read a guessed file id")

    summary = IngestSummary("connection", failure_categories={})
    execution = GdriveExecution("00000000-0000-0000-0000-000000000001", 1, 1,
                                "00000000-0000-0000-0000-000000000002", "later", "hash", {})
    asyncio.run(_drain_pending(
        object(), execution, Source(), Connection("connection", "gdrive"), store,
        progress.namespace, 1, summary, 10,
    ))
    assert store.pending_count(progress.namespace, 1) == 0
    assert summary.total == 0
    store.close()


def test_pending_upsert_is_pushed_and_acknowledged_once(tmp_path):
    store = StateStore(str(tmp_path / "upsert.sqlite"))
    progress = store.begin_generation(StreamKey("team", "connection", "credential"), 1, start_token="opaque")
    store.enqueue_work(progress.namespace, 1, "DocA", "upsert", {"file_id": "DocA"})

    class Source:
        def _metadata(self, file_id):
            return {"id": file_id}

        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], body="Body")

    class Client:
        pushes = 0
        checkpoints = 0

        async def push(self, payload, *, execution):
            self.pushes += 1
            assert execution.integration_id == "00000000-0000-0000-0000-000000000001"
            return IngestResult("created", "item-id", payload.path)

        async def checkpoint_gdrive_execution(self, execution, progress):
            self.checkpoints += 1

    client = Client()
    summary = IngestSummary("connection", failure_categories={})
    execution = GdriveExecution("00000000-0000-0000-0000-000000000001", 1, 1,
                                "00000000-0000-0000-0000-000000000002", "later", "hash", {})
    asyncio.run(_drain_pending(
        client, execution, Source(), Connection("connection", "gdrive"), store,
        progress.namespace, 1, summary, 10,
    ))

    assert client.pushes == 1
    assert client.checkpoints == 1
    assert summary.created == 1
    assert store.pending_count(progress.namespace, 1) == 0
    store.close()


def test_stale_authority_stops_before_another_provider_read_and_preserves_pending(tmp_path):
    store = StateStore(str(tmp_path / "stale.sqlite"))
    progress = store.begin_generation(StreamKey("team", "connection", "credential"), 1, start_token="opaque")
    store.enqueue_work(progress.namespace, 1, "DocA", "upsert")
    store.enqueue_work(progress.namespace, 1, "DocB", "upsert")

    class Source:
        reads = []
        def _metadata(self, file_id):
            self.reads.append(file_id)
            return {"id": file_id}
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], body="Body")

    class Client:
        async def push(self, payload, *, execution):
            raise BrainError(409, "stale_execution", "replaced")

    source = Source()
    execution = GdriveExecution("00000000-0000-0000-0000-000000000001", 1, 1,
                                "00000000-0000-0000-0000-000000000002", "later", "hash", {})
    with pytest.raises(BrainError, match="stale_execution"):
        asyncio.run(_drain_pending(
            Client(), execution, source, Connection("connection", "gdrive"), store,
            progress.namespace, 1, IngestSummary("connection", failure_categories={}), 10,
        ))
    assert source.reads == ["DocA"]
    assert store.pending_count(progress.namespace, 1) == 2
    store.close()


def test_pause_during_failed_extraction_is_terminal_before_next_provider_read(tmp_path):
    store = StateStore(str(tmp_path / "paused-after-failure.sqlite"))
    progress = store.begin_generation(StreamKey("team", "connection", "credential"), 1,
                                      start_token="opaque")
    store.enqueue_work(progress.namespace, 1, "DocA", "upsert")
    store.enqueue_work(progress.namespace, 1, "DocB", "upsert")

    class Source:
        reads = []

        def _metadata(self, file_id):
            self.reads.append(file_id)
            if file_id == "DocB":
                raise BrainError(409, "connection_unavailable", "paused")
            return {"id": file_id}

        def _raw_doc(self, _meta):
            raise IncompleteExtractionError("provider returned incomplete tab content")

    source = Source()
    execution = GdriveExecution("00000000-0000-0000-0000-000000000001", 1, 1,
                                "00000000-0000-0000-0000-000000000002", "later", "hash", {})
    with pytest.raises(BrainError, match="connection_unavailable"):
        asyncio.run(_drain_pending(
            object(), execution, source, Connection("connection", "gdrive"), store,
            progress.namespace, 1, IngestSummary("connection", failure_categories={}), 10,
        ))

    assert source.reads == ["DocA", "DocB"]
    assert store.pending_count(progress.namespace, 1) == 2
    store.close()


def test_server_progress_ack_happens_before_recoverable_sqlite_mirror(tmp_path):
    store = StateStore(str(tmp_path / "mirror.sqlite"))
    progress = store.begin_generation(StreamKey("team", "connection", "credential"), 1, start_token="old")
    events = []

    class Client:
        async def checkpoint_gdrive_execution(self, execution, payload):
            events.append(("server", payload["page_token"]))
            return {"progress_revision": 9, "progress": payload}

    original = store.update_progress
    def crash_before_mirror(namespace, **changes):
        events.append(("mirror", changes.get("page_token")))
        raise OSError("simulated local disk crash")
    store.update_progress = crash_before_mirror
    execution = GdriveExecution("00000000-0000-0000-0000-000000000001", 1, 1,
                                "00000000-0000-0000-0000-000000000002", "later", "hash", {})
    with pytest.raises(OSError, match="disk crash"):
        asyncio.run(_checkpoint_progress(
            Client(), execution, store, progress.namespace, page_token="next", phase="current",
        ))
    assert events == [("server", "next"), ("mirror", "next")]
    store.update_progress = original
    store.close()


@pytest.mark.asyncio
async def test_restart_after_pause_resumes_saved_cursor_and_pending_without_fresh_start_token(tmp_path):
    path = tmp_path / "paused-restart.sqlite"
    key = StreamKey("team", "connection", "account", "my-drive")
    namespace = key.namespace(7)
    state = StateStore(str(path))
    state.begin_generation(key, 7, start_token="baseline-start")
    active_snapshot = state.begin_selection_snapshot(namespace, 7, [])
    state.publish_selection_snapshot(namespace, 7, active_snapshot)
    state.update_progress(
        namespace,
        phase="partial",
        page_token="saved-change-page",
        listing_complete=True,
        server_revision=12,
    )
    state.enqueue_work(namespace, 7, "notification:paused", "poll", {})
    state.close()
    state = StateStore(str(path))

    class Changes:
        start_calls = 0
        list_calls = []

        def getStartPageToken(self, **_kwargs):
            self.start_calls += 1
            raise AssertionError("resume must not request a fresh start token")

        def list(self, **kwargs):
            self.list_calls.append(kwargs["pageToken"])
            return _Request({
                "changes": [], "nextPageToken": None,
                "newStartPageToken": "terminal-cursor",
            })

    class Drive:
        def __init__(self): self.api = Changes()
        def changes(self): return self.api

    class Source:
        def fetch(self):
            raise AssertionError("completed baseline must not restart")
        def _execute(self, request): return request.execute()

    class Client:
        async def checkpoint_gdrive_execution(self, _execution, progress):
            return {"progress_revision": 13, "progress": progress}

    execution = GdriveExecution(
        "connection", 7, 9, "owner", "later", "scope",
        {"selectionState": "selected"},
        progress={
            "phase": "partial", "drive_id": "my-drive",
            "baseline_start_token": "baseline-start", "page_token": "saved-change-page",
            "listing_complete": True, "last_error": "paused",
        },
        progress_revision=12,
    )
    drive = Drive()
    summary = await _run_gdrive_stream_unlocked(
        BrainSettings(base_url="http://brain", api_key="key", team="team"),
        Connection("docs", "gdrive"), state,
        client=Client(), execution=execution,
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=drive, generation=7, drive_id="my-drive",
        namespace=namespace, max_work=10,
    )

    assert summary.failed == 0
    assert drive.api.start_calls == 0
    assert drive.api.list_calls == ["saved-change-page"]
    assert state.pending_count(namespace, 7) == 0
    resumed = state.get_progress(namespace)
    assert resumed is not None
    assert resumed.page_token == "terminal-cursor"
    assert resumed.phase == "partial"
    assert resumed.last_error == "stream complete; awaiting all-stream reconciliation"
    state.close()


def test_materialized_page_retains_ack_until_cursor_commit_and_restart(tmp_path):
    path = tmp_path / "page-ack.sqlite"
    state = StateStore(str(path))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account", "my-drive"), 2,
        start_token="opaque-start",
    )
    page = state.materialize_page(
        progress.namespace, 2, "changes:one", "changes", "opaque-start",
        "opaque-next", None, [("doc-a", "upsert", {"file_id": "doc-a"})],
    )
    (work,) = state.list_pending(progress.namespace, 2)
    state.ack_work(work)
    assert state.pending_count(progress.namespace, 2) == 0
    assert state.next_uncommitted_page(progress.namespace, 2) == page
    state.close()

    restarted = StateStore(str(path))
    restored = restarted.next_uncommitted_page(progress.namespace, 2)
    assert restored is not None and restored.next_token == "opaque-next"
    assert restarted.list_pending(progress.namespace, 2) == []
    restarted.commit_page(progress.namespace, 2, restored.page_id)
    restarted.purge_committed_page_work(progress.namespace, 2, restored.page_id)
    assert restarted.next_uncommitted_page(progress.namespace, 2) is None
    restarted.close()


@pytest.mark.asyncio
async def test_durable_baseline_budget_two_resumes_third_doc_and_finishes_exact_boundary(tmp_path):
    state = StateStore(str(tmp_path / "budget.sqlite"))
    key = StreamKey("team", "connection", "account", "my-drive")
    namespace = key.namespace(4)

    files = [{
        "id": f"doc-{index}", "name": f"Doc {index}",
        "mimeType": "application/vnd.google-apps.document",
        "modifiedTime": "2026-09-22T00:00:00Z", "parents": ["folder"],
    } for index in range(3)]

    class Changes:
        def getStartPageToken(self, **_kwargs): return _Request({"startPageToken": "start"})
        def list(self, **_kwargs):
            return _Request({"changes": [], "newStartPageToken": "terminal"})

    class Files:
        calls = 0
        def list(self, **_kwargs):
            self.calls += 1
            return _Request({"files": files})

    class Drive:
        def __init__(self): self.file_api, self.change_api = Files(), Changes()
        def files(self): return self.file_api
        def changes(self): return self.change_api

    class Source:
        def _execute(self, request): return request.execute()
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], title=meta["name"], body="body")
        def _metadata(self, file_id):
            return next(meta for meta in files if meta["id"] == file_id)

    class Client:
        pushes = []
        revision = 0
        async def push(self, payload, *, execution):
            provider_id = payload.frontmatter["source_id"]
            self.pushes.append(provider_id)
            return IngestResult("created", provider_id, payload.path)
        async def checkpoint_gdrive_execution(self, execution, progress):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": progress}

    execution = GdriveExecution(
        "connection", 4, 1, "owner", "later", "scope", {}, progress={}, progress_revision=0,
    )
    client, drive, source = Client(), Drive(), Source()
    options = {
        "credential_identity": "account", "selection_state": "selected",
        "folder_ids": ["folder"], "recursive": True,
    }
    first = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=execution, options=options, source=source, drive=drive,
        generation=4, drive_id="my-drive", namespace=namespace, max_work=2,
    )
    assert first.created == 2
    assert state.pending_count(namespace, 4) == 1

    second = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=execution, options=options, source=source, drive=drive,
        generation=4, drive_id="my-drive", namespace=namespace, max_work=1,
    )
    assert second.created == 1
    assert client.pushes == ["doc-0", "doc-1", "doc-2"]
    assert drive.file_api.calls == 1
    assert state.pending_count(namespace, 4) == 0
    assert state.get_progress(namespace).listing_complete is True
    state.close()


def test_selection_membership_dedupes_overlapping_roots_and_removes_only_current_claim(tmp_path):
    state = StateStore(str(tmp_path / "membership.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account", "my-drive"), 8, start_token="start",
    )
    state.record_membership(progress.namespace, 8, "doc", "folder-a", "my-drive")
    state.record_membership(progress.namespace, 8, "doc", "folder-b", "my-drive")
    state.record_membership(progress.namespace, 8, "doc", "folder-a", "my-drive")
    assert state.membership_ids(progress.namespace, 8) == ["doc"]
    row = state._db.execute(
        "select root_ids from selected_membership where namespace=? and provider_id='doc'",
        (progress.namespace,),
    ).fetchone()
    assert json.loads(row[0]) == ["folder-a", "folder-b"]
    assert state.remove_membership(progress.namespace, 8, "doc") is True
    assert state.membership_ids(progress.namespace, 8) == []
    state.close()


def test_provider_retry_after_beyond_deadline_defers_without_busy_loop(monkeypatch):
    calls = []

    class Response:
        status = 429
        headers = {"Retry-After": "120"}

    class RateLimited(Exception):
        resp = Response()

    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1, provider_retry_attempts=5,
    )

    def request():
        calls.append(1)
        raise RateLimited("quota")

    with pytest.raises(Exception) as raised:
        source._provider_call(request)
    assert type(raised.value).__name__ == "ProviderDeferred"
    assert getattr(raised.value, "category") == "rate_limited"
    assert len(calls) == 1


def test_provider_timeout_retries_are_bounded_and_classified(monkeypatch):
    calls = []
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.sleep", lambda _delay: None)
    monkeypatch.setattr("aios_ingest.sources.gdrive.random.uniform", lambda *_args: 0)
    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=10, provider_retry_attempts=3,
    )

    def request():
        calls.append(1)
        raise TimeoutError("provider timed out")

    with pytest.raises(Exception) as raised:
        source._provider_call(request)
    assert type(raised.value).__name__ == "ProviderDeferred"
    assert getattr(raised.value, "category") == "provider_timeout"
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_multi_stream_captures_my_drive_and_each_shared_drive_before_any_enumeration(
    tmp_path, monkeypatch,
):
    integration_id = "00000000-0000-0000-0000-000000000001"
    starts, runs = [], []

    class Changes:
        def getStartPageToken(self, **kwargs):
            drive_id = kwargs.get("driveId", "my-drive")
            starts.append(drive_id)
            return _Request({"startPageToken": f"start:{drive_id}"})

    class Drive:
        def changes(self): return Changes()

    class Client:
        revision = 0
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 5, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": ["direct"], "folderIds": [],
                "sharedDriveIds": ["shared-b", "shared-a"], "selectionState": "selected",
            })
        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": "account"}}
        def gdrive_token_provider(self, execution, grant):
            class Provider:
                def close(self): pass
            return Provider()
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, progress):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": progress}
        async def release_gdrive_execution(self, execution): pass

    class Source:
        def __init__(self, **kwargs): pass
        def _services(self): return Drive(), object()
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id): return {"id": file_id}

    async def capture(_settings, _conn, _state, **kwargs):
        runs.append((kwargs["drive_id"], list(starts)))
        return IngestSummary("docs", failure_categories={})

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", capture)
    state = StateStore(str(tmp_path / "multi.sqlite"))
    await run_gdrive_stream(
        BrainSettings("http://brain", "key", "team"),
        Connection("docs", "gdrive", options={"integration_id": integration_id}), state,
    )

    assert starts == ["my-drive", "shared-a", "shared-b"]
    assert [drive for drive, _ in runs] == ["my-drive", "shared-a", "shared-b"]
    assert all(snapshot == starts for _, snapshot in runs)
    progresses = state.list_progress(integration_id, 5)
    assert {progress.key.drive_id: progress.baseline_start_token for progress in progresses} == {
        "my-drive": "start:my-drive", "shared-a": "start:shared-a", "shared-b": "start:shared-b",
    }
    state.close()


@pytest.mark.asyncio
async def test_exhausted_first_stream_work_budget_still_schedules_later_drive_discovery(
    tmp_path, monkeypatch,
):
    integration_id = "00000000-0000-0000-0000-000000000009"
    scheduled = []

    class Changes:
        def getStartPageToken(self, **kwargs):
            return _Request({"startPageToken": f"start:{kwargs.get('driveId')}"})

    class Drive:
        def changes(self): return Changes()

    class Client:
        revision = 0
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 5, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": [], "folderIds": [],
                "sharedDriveIds": ["shared-a", "shared-b"], "selectionState": "selected",
            })
        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": "account"}}
        def gdrive_token_provider(self, execution, grant):
            class Provider:
                def close(self): pass
            return Provider()
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, progress):
            self.revision += 1
            execution.progress.clear()
            execution.progress.update(progress)
            return {"progress_revision": self.revision, "progress": progress}
        async def release_gdrive_execution(self, execution): pass

    class Source:
        def __init__(self, **kwargs): pass
        def set_run_deadline(self, deadline): pass
        def _services(self): return Drive(), object()
        def _execute(self, request): return request.execute()

    async def capture(_settings, _conn, _state, **kwargs):
        scheduled.append((
            kwargs["drive_id"], kwargs["max_work"], kwargs["discovery_budget"],
        ))
        return IngestSummary(
            "docs", failed=kwargs["max_work"], failure_categories={"malformed": kwargs["max_work"]},
        )

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", capture)
    state = StateStore(str(tmp_path / "fair-streams.sqlite"))
    await run_gdrive_stream(
        BrainSettings("http://brain", "key", "team"),
        Connection("docs", "gdrive", options={"integration_id": integration_id}),
        state, max_work=1,
    )
    assert scheduled == [
        ("shared-a", 1, 25),
        ("shared-b", 0, 25),
    ]
    state.close()
    state = StateStore(str(tmp_path / "fair-streams.sqlite"))
    scheduled.clear()
    await run_gdrive_stream(
        BrainSettings("http://brain", "key", "team"),
        Connection("docs", "gdrive", options={"integration_id": integration_id}),
        state, max_work=1,
    )
    assert scheduled == [
        ("shared-b", 1, 25),
        ("shared-a", 0, 25),
    ]
    state.close()


@pytest.mark.asyncio
async def test_all_stream_reconciliation_waits_for_every_terminal_drain(tmp_path, monkeypatch):
    integration_id = "00000000-0000-0000-0000-000000000019"
    terminal_b = False

    class Changes:
        def getStartPageToken(self, **kwargs):
            return _Request({"startPageToken": f"start:{kwargs.get('driveId')}"})

    class Drive:
        def changes(self): return Changes()

    class Client:
        reconciles = 0
        revision = 0
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 6, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": [], "folderIds": [], "sharedDriveIds": ["drive-a", "drive-b"],
                "selectionState": "selected",
            })
        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": "account"}}
        def gdrive_token_provider(self, execution, grant):
            class Provider:
                def close(self): pass
            return Provider()
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": payload}
        async def reconcile_gdrive(self, execution, **kwargs):
            type(self).reconciles += 1
            return {"items": 0}
        async def release_gdrive_execution(self, execution): pass

    class Source:
        def __init__(self, **kwargs): pass
        def set_run_deadline(self, deadline): pass
        def _services(self): return Drive(), object()
        def _execute(self, request): return request.execute()

    async def mark_stream(_settings, _conn, state, **kwargs):
        nonlocal terminal_b
        namespace, generation = kwargs["namespace"], kwargs["generation"]
        progress = state.get_progress(namespace)
        if progress.active_snapshot is None:
            snapshot = state.begin_selection_snapshot(namespace, generation, [])
            state.publish_selection_snapshot(namespace, generation, snapshot)
        terminal = kwargs["drive_id"] == "drive-a" or terminal_b
        state.update_progress(
            namespace, listing_complete=True,
            page_token="terminal" if terminal else "next-page",
            checkpoint_id="terminal-page" if terminal else "continuation-page",
            terminal_drain_token="terminal" if terminal else None,
            terminal_drain_checkpoint_id="terminal-page" if terminal else None,
            terminal_drain_acknowledged=terminal,
            drain_observation=1,
            terminal_drain_observation=1 if terminal else None,
        )
        return IngestSummary("docs", failure_categories={})

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", mark_stream)
    path = tmp_path / "all-terminal.sqlite"
    state = StateStore(str(path))
    await run_gdrive_stream(
        BrainSettings("http://brain", "key", "team"),
        Connection("docs", "gdrive", options={"integration_id": integration_id}), state,
    )
    assert Client.reconciles == 0
    state.close()

    terminal_b = True
    state = StateStore(str(path))
    await run_gdrive_stream(
        BrainSettings("http://brain", "key", "team"),
        Connection("docs", "gdrive", options={"integration_id": integration_id}), state,
    )
    assert Client.reconciles == 1
    assert {p.phase for p in state.list_progress(integration_id, 6)} == {"current"}
    state.close()


def test_malformed_document_does_not_abort_later_durable_obligation(tmp_path):
    state = StateStore(str(tmp_path / "malformed.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 1, start_token="start",
    )
    state.enqueue_work(progress.namespace, 1, "a-bad", "upsert")
    state.enqueue_work(progress.namespace, 1, "b-good", "upsert")

    class Source:
        def _metadata(self, file_id): return {"id": file_id}
        def _raw_doc(self, meta):
            if meta["id"] == "a-bad":
                raise IncompleteExtractionError("malformed tab")
            return RawDoc(source="gdrive", external_id=meta["id"], body="good")

    class Client:
        pushed = []
        persisted = {"a-bad": "prior known-complete body"}
        async def push(self, payload, *, execution):
            self.pushed.append(payload.frontmatter["source_id"])
            self.persisted[payload.frontmatter["source_id"]] = payload.body
            return IngestResult("created", "item", payload.path)
        async def checkpoint_gdrive_execution(self, execution, progress):
            return {"progress_revision": 1, "progress": progress}

    summary = IngestSummary("docs", failure_categories={})
    asyncio.run(_drain_pending(
        Client(), GdriveExecution("connection", 1, 1, "owner", "later", "scope", {}),
        Source(), Connection("docs", "gdrive"), state, progress.namespace, 1, summary, 10,
    ))
    assert summary.failed == 1 and summary.created == 1
    assert Client.pushed == ["b-good"]
    assert Client.persisted == {"a-bad": "prior known-complete body", "b-good": "good"}
    assert state.pending_count(progress.namespace, 1) == 1
    deferred = state._db.execute(
        "select item_key,not_before from pending_work where namespace=? and acknowledged_at is null",
        (progress.namespace,),
    ).fetchone()
    assert deferred["item_key"] == "a-bad" and deferred["not_before"]
    state.close()


@pytest.mark.asyncio
async def test_invalid_change_cursor_starts_controlled_rescan_without_claiming_empty(tmp_path):
    state = StateStore(str(tmp_path / "invalid-cursor.sqlite"))
    key = StreamKey("team", "connection", "account", "my-drive")
    namespace = key.namespace(6)
    state.begin_generation(key, 6, start_token="old-start")
    state.update_progress(namespace, phase="current", page_token="expired", listing_complete=True)
    state.record_membership(namespace, 6, "existing", "folder", "my-drive")

    class Changes:
        def list(self, **kwargs): return ("list", kwargs)
        def getStartPageToken(self, **kwargs): return _Request({"startPageToken": "fresh-start"})

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request):
            if isinstance(request, tuple):
                raise ProviderCursorInvalid("expired")
            return request.execute()

    class Client:
        revision = 0
        async def checkpoint_gdrive_execution(self, execution, progress):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": progress}

    summary = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=Client(), execution=GdriveExecution(
            "connection", 6, 1, "owner", "later", "scope", {}, progress={}, progress_revision=0,
        ), options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=6, drive_id="my-drive",
        namespace=namespace, max_work=10,
    )

    assert summary.failure_categories == {"invalid_cursor": 1}
    recovered = state.get_progress(namespace)
    assert recovered.phase == "baselining"
    assert recovered.baseline_start_token == "fresh-start"
    assert recovered.page_token is None
    assert recovered.listing_complete is False
    assert state.membership_ids(namespace, 6) == ["existing"]
    assert state.membership_ids(namespace, 6, building=True) == []
    state.close()


@pytest.mark.asyncio
async def test_change_page_re_evaluates_moves_into_and_out_of_selected_subtree(tmp_path):
    state = StateStore(str(tmp_path / "moves.sqlite"))
    key = StreamKey("team", "connection", "account", "my-drive")
    namespace = key.namespace(2)
    state.begin_generation(key, 2, start_token="start")
    state.update_progress(namespace, phase="current", page_token="cursor", listing_complete=True)
    state.replace_roots(namespace, 2, [("root", "folder", "my-drive", True)])
    snapshot_id = state.snapshot_id(namespace)
    state.complete_traversal(namespace, 2, "root", "root", None, snapshot_id=snapshot_id)
    state.enqueue_traversal(namespace, 2, "root", "selected-folder", "my-drive")
    state.complete_traversal(namespace, 2, "root", "selected-folder", None)
    state.record_membership(namespace, 2, "moved-out", "root", "my-drive")
    state.publish_selection_snapshot(namespace, 2, snapshot_id)
    state.update_progress(namespace, phase="current", page_token="cursor", listing_complete=True)

    class Changes:
        def list(self, **kwargs):
            return _Request({
                "changes": [
                    {"fileId": "moved-out", "file": {
                        "id": "moved-out", "mimeType": "application/vnd.google-apps.document",
                        "parents": ["outside"],
                    }},
                    {"fileId": "moved-in", "file": {
                        "id": "moved-in", "name": "Moved in",
                        "mimeType": "application/vnd.google-apps.document",
                        "modifiedTime": "2026-09-22T00:00:00Z", "parents": ["selected-folder"],
                    }},
                ],
                "newStartPageToken": "terminal",
            })

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], title=meta.get("name"), body="body")
        def _metadata(self, file_id):
            assert file_id == "moved-in"
            return {
                "id": "moved-in", "name": "Moved in",
                "mimeType": "application/vnd.google-apps.document",
                "modifiedTime": "2026-09-22T00:00:00Z", "parents": ["selected-folder"],
            }

    class Client:
        pushed, removed, revision = [], [], 0
        async def push(self, payload, *, execution):
            self.pushed.append(payload.frontmatter["source_id"])
            return IngestResult("created", "item", payload.path)
        async def reconcile_gdrive(self, execution, **kwargs):
            self.removed.extend(kwargs.get("removed_provider_ids") or [])
            return {"items": 1}
        async def checkpoint_gdrive_execution(self, execution, progress):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": progress}

    client = Client()
    summary = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=GdriveExecution(
            "connection", 2, 1, "owner", "later", "scope", {}, progress={}, progress_revision=0,
        ), options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=2, drive_id="my-drive",
        namespace=namespace, max_work=10,
    )
    assert summary.created == 1 and summary.removed == 1
    assert client.pushed == ["moved-in"] and client.removed == ["moved-out"]
    assert state.membership_ids(namespace, 2) == ["moved-in"]
    state.close()


def test_snapshot_incarnation_preserves_active_membership_until_atomic_publish(tmp_path):
    state = StateStore(str(tmp_path / "snapshot-incarnation.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 9, start_token="start",
    )
    first = state.begin_selection_snapshot(
        progress.namespace, 9, [("folder-a", "folder", "my-drive", True)],
    )
    state.record_membership(
        progress.namespace, 9, "old-doc", "folder-a", "my-drive", snapshot_id=first,
    )
    state.complete_traversal(
        progress.namespace, 9, "folder-a", "folder-a", None, snapshot_id=first,
    )
    state.publish_selection_snapshot(progress.namespace, 9, first)

    replacement = state.begin_selection_snapshot(
        progress.namespace, 9, [("folder-b", "folder", "my-drive", True)],
    )
    assert replacement > first
    assert state.membership_ids(progress.namespace, 9) == ["old-doc"]
    assert state.membership_ids(progress.namespace, 9, snapshot_id=replacement) == []
    assert state.snapshot_complete(progress.namespace, 9, replacement) is False

    state.record_membership(
        progress.namespace, 9, "new-doc", "folder-b", "my-drive",
        snapshot_id=replacement,
    )
    state.complete_traversal(
        progress.namespace, 9, "folder-b", "folder-b", None,
        snapshot_id=replacement,
    )
    state.publish_selection_snapshot(progress.namespace, 9, replacement)
    assert state.membership_ids(progress.namespace, 9) == ["new-doc"]
    state.close()


def test_legacy_membership_only_state_is_adopted_as_active_snapshot(tmp_path):
    path = tmp_path / "legacy-selection.sqlite"
    database = sqlite3.connect(path)
    database.executescript(
        """
        CREATE TABLE selection_roots (
          namespace TEXT NOT NULL, generation INTEGER NOT NULL, root_id TEXT NOT NULL,
          root_kind TEXT NOT NULL, drive_id TEXT NOT NULL, recursive INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(namespace,generation,root_kind,root_id));
        CREATE TABLE traversal_queue (
          namespace TEXT NOT NULL, generation INTEGER NOT NULL, root_id TEXT NOT NULL,
          folder_id TEXT NOT NULL, drive_id TEXT NOT NULL, page_token TEXT NOT NULL DEFAULT '',
          completed_at TEXT, PRIMARY KEY(namespace,generation,root_id,folder_id,page_token));
        CREATE TABLE selected_membership (
          namespace TEXT NOT NULL, generation INTEGER NOT NULL, provider_id TEXT NOT NULL,
          root_ids TEXT NOT NULL DEFAULT '[]', drive_id TEXT NOT NULL, seen_at TEXT NOT NULL,
          PRIMARY KEY(namespace,generation,provider_id));
        INSERT INTO selected_membership VALUES(
          'legacy-namespace',4,'legacy-doc','["legacy-root"]','my-drive','2026-09-22T00:00:00Z');
        """
    )
    database.commit()
    database.close()

    state = StateStore(str(path))
    adopted = state._db.execute(
        "SELECT status FROM selection_snapshots WHERE namespace=? AND generation=? AND snapshot_id=1",
        ("legacy-namespace", 4),
    ).fetchone()
    assert adopted["status"] == "active"
    assert state.membership_ids("legacy-namespace", 4, snapshot_id=1) == ["legacy-doc"]
    state.close()


def test_shared_drive_snapshot_uses_actual_drive_id_and_repairs_legacy_root(tmp_path):
    path = tmp_path / "shared-root.sqlite"
    state = StateStore(str(path))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account", "drive-a"), 4, start_token="start",
    )
    snapshot = state.begin_selection_snapshot(
        progress.namespace, 4, [("drive-a", "drive", "drive-a", True)],
    )
    row = state.next_traversal(progress.namespace, 4, snapshot_id=snapshot)
    assert row["folder_id"] == "drive-a"
    state._db.execute(
        "UPDATE traversal_queue SET folder_id='root' WHERE namespace=? AND generation=?",
        (progress.namespace, 4),
    )
    state._db.commit()
    state.close()

    restarted = StateStore(str(path))
    row = restarted.next_traversal(progress.namespace, 4, snapshot_id=snapshot)
    assert row["folder_id"] == "drive-a"
    assert restarted.roots_for_parent(
        progress.namespace, 4, "drive-a", snapshot_id=snapshot,
    ) == ["drive-a"]
    assert restarted.get_progress(progress.namespace).recovery_required is False
    restarted.close()


def test_ambiguous_legacy_shared_drive_root_forces_controlled_recovery(tmp_path):
    path = tmp_path / "ambiguous-shared-root.sqlite"
    state = StateStore(str(path))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account", "drive-a"), 4, start_token="start",
    )
    snapshot = state.begin_selection_snapshot(
        progress.namespace, 4, [("drive-a", "drive", "drive-a", True)],
    )
    state._db.execute(
        "UPDATE traversal_queue SET folder_id='root',drive_id='unknown-drive' "
        "WHERE namespace=? AND generation=? AND snapshot_id=?",
        (progress.namespace, 4, snapshot),
    )
    state._db.commit()
    state.close()

    restarted = StateStore(str(path))
    recovered = restarted.get_progress(progress.namespace)
    assert recovered.recovery_required is True
    assert recovered.listing_complete is False
    assert recovered.phase == "baselining"
    assert "controlled rescan" in recovered.last_error
    restarted.close()


@pytest.mark.asyncio
async def test_shared_drive_root_parent_edit_import_and_real_move_out(tmp_path):
    state = StateStore(str(tmp_path / "shared-changes.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account", "drive-a"), 7,
        start_token="start", phase="current",
    )
    snapshot = state.begin_selection_snapshot(
        progress.namespace, 7, [("drive-a", "drive", "drive-a", True)],
    )
    state.complete_traversal(
        progress.namespace, 7, "drive-a", "drive-a", None, snapshot_id=snapshot,
    )
    state.publish_selection_snapshot(progress.namespace, 7, snapshot)
    state.record_membership(
        progress.namespace, 7, "edited", "drive-a", "drive-a", snapshot_id=snapshot,
    )
    state.record_membership(
        progress.namespace, 7, "moved", "drive-a", "drive-a", snapshot_id=snapshot,
    )
    state.update_progress(
        progress.namespace, listing_complete=True, page_token="cursor",
        last_success_at="2026-09-20T00:00:00+00:00",
    )

    changes = [
        {"fileId": "edited", "file": {"id": "edited", "mimeType": "application/vnd.google-apps.document", "driveId": "drive-a", "parents": ["drive-a"]}},
        {"fileId": "new", "file": {"id": "new", "mimeType": "application/vnd.google-apps.document", "driveId": "drive-a", "parents": ["drive-a"]}},
        {"fileId": "moved", "file": {"id": "moved", "mimeType": "application/vnd.google-apps.document", "driveId": "drive-b", "parents": ["drive-b"]}},
    ]

    class Changes:
        def list(self, **_kwargs):
            return _Request({"changes": changes, "newStartPageToken": "terminal"})

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id):
            return {"id": file_id, "mimeType": "application/vnd.google-apps.document", "driveId": "drive-a", "parents": ["drive-a"]}
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], body=meta["id"])

    class Client:
        revision = 0
        pushed, removed = [], []
        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": payload}
        async def push(self, payload, *, execution):
            self.pushed.append(payload.frontmatter["source_id"])
            return IngestResult("updated", "item", payload.path)
        async def reconcile_gdrive(self, execution, **kwargs):
            self.removed.extend(kwargs.get("removed_provider_ids") or [])
            return {"items": len(kwargs.get("removed_provider_ids") or [])}

    client = Client()
    result = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=GdriveExecution("connection", 7, 1, "owner", "later", "scope", {}),
        options={"credential_identity": "account", "selection_state": "selected", "shared_drive_ids": ["drive-a"]},
        source=Source(), drive=Drive(), generation=7, drive_id="drive-a",
        namespace=progress.namespace, max_work=3, discovery_budget=1, retry_budget=0,
    )
    assert result.updated == 2 and client.pushed == ["edited", "new"]
    assert client.removed == ["moved"]
    assert state.membership_ids(progress.namespace, 7, snapshot_id=snapshot) == ["edited", "new"]
    state.close()


def test_observation_revisions_supersede_both_directions_and_survive_restart(tmp_path):
    path = tmp_path / "observation-revisions.sqlite"
    state = StateStore(str(path))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 8, start_token="start",
    )
    snapshot = state.begin_selection_snapshot(progress.namespace, 8, [])
    state.publish_selection_snapshot(progress.namespace, 8, snapshot)
    state.materialize_page(
        progress.namespace, 8, "page-upsert-1", "changes", "a", "b", None,
        [("doc", "upsert", {"file_id": "doc"})], snapshot_id=snapshot,
        membership_additions=[("doc", "direct", "my-drive")],
    )
    first = state.list_pending(progress.namespace, 8)[0]
    state.materialize_page(
        progress.namespace, 8, "page-remove", "changes", "b", "c", None,
        [("doc", "remove", {"file_id": "doc"})], snapshot_id=snapshot,
        membership_removals=["doc"],
    )
    removed = state.list_pending(progress.namespace, 8)[0]
    assert removed.action == "remove" and removed.observation_revision > first.observation_revision
    assert state.work_is_current(first) is False
    state.materialize_page(
        progress.namespace, 8, "page-upsert-1", "changes", "a", "b", None,
        [("doc", "upsert", {"file_id": "doc"})], snapshot_id=snapshot,
        membership_additions=[("doc", "direct", "my-drive")],
    )
    assert state.list_pending(progress.namespace, 8)[0].action == "remove"
    assert state.has_membership(
        progress.namespace, 8, "doc", snapshot_id=snapshot,
    ) is False

    state.materialize_page(
        progress.namespace, 8, "page-upsert-2", "changes", "c", None, "d",
        [("doc", "upsert", {"file_id": "doc"})], snapshot_id=snapshot,
        membership_additions=[("doc", "direct", "my-drive")],
    )
    restored = state.list_pending(progress.namespace, 8)[0]
    assert restored.action == "upsert" and restored.observation_revision > removed.observation_revision
    assert state.work_membership_current(restored) is True
    outcomes = state._db.execute(
        "SELECT page_id,status FROM page_obligation_outcomes WHERE namespace=? ORDER BY observation_revision",
        (progress.namespace,),
    ).fetchall()
    assert [(row["page_id"], row["status"]) for row in outcomes] == [
        ("page-upsert-1", "superseded"),
        ("page-remove", "superseded"),
        ("page-upsert-2", "pending"),
    ]
    revision = restored.observation_revision
    state.close()

    reopened = StateStore(str(path))
    replayed = reopened.list_pending(progress.namespace, 8)[0]
    assert replayed.action == "upsert" and replayed.observation_revision == revision
    reopened.close()


def test_legacy_conflicting_obligations_upgrade_to_one_monotonic_winner(tmp_path):
    path = tmp_path / "legacy-obligations.sqlite"
    database = sqlite3.connect(path)
    database.executescript(
        """
        CREATE TABLE pending_work (
          namespace TEXT NOT NULL, generation INTEGER NOT NULL, item_key TEXT NOT NULL,
          action TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', page_id TEXT,
          attempts INTEGER NOT NULL DEFAULT 0, not_before TEXT, last_error TEXT,
          acknowledged_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(namespace,generation,item_key,action));
        INSERT INTO pending_work VALUES(
          'legacy',2,'doc','upsert','{}','old-page',0,NULL,NULL,NULL,
          '2026-09-22T00:00:00Z','2026-09-22T00:00:00Z');
        INSERT INTO pending_work VALUES(
          'legacy',2,'doc','remove','{}','new-page',0,NULL,NULL,NULL,
          '2026-09-22T00:00:01Z','2026-09-22T00:00:01Z');
        """
    )
    database.commit()
    database.close()

    state = StateStore(str(path))
    work = state.list_pending("legacy", 2)
    assert len(work) == 1
    assert work[0].action == "remove" and work[0].observation_revision == 1
    state.enqueue_work("legacy", 2, "doc", "upsert", {"restored": True})
    restored = state.list_pending("legacy", 2)[0]
    assert restored.action == "upsert" and restored.observation_revision == 2
    state.close()


@pytest.mark.asyncio
async def test_in_flight_upsert_is_discarded_when_newer_remove_observation_arrives(tmp_path):
    state = StateStore(str(tmp_path / "in-flight-supersession.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 9, start_token="start",
    )
    snapshot = state.begin_selection_snapshot(progress.namespace, 9, [])
    state.publish_selection_snapshot(progress.namespace, 9, snapshot)
    state.materialize_page(
        progress.namespace, 9, "upsert-page", "changes", "a", "b", None,
        [("doc", "upsert", {"file_id": "doc"})], snapshot_id=snapshot,
        membership_additions=[("doc", "direct", "my-drive")],
    )

    class Source:
        def _metadata(self, file_id):
            state.materialize_page(
                progress.namespace, 9, "remove-page", "changes", "b", None, "c",
                [(file_id, "remove", {"file_id": file_id})], snapshot_id=snapshot,
                membership_removals=[file_id],
            )
            return {"id": file_id, "mimeType": "application/vnd.google-apps.document"}
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], body="stale")

    class Client:
        pushes = 0
        async def push(self, payload, *, execution):
            self.pushes += 1
            return IngestResult("created", "item", payload.path)
        async def checkpoint_gdrive_execution(self, execution, progress):
            return {"progress_revision": 1, "progress": progress}

    client = Client()
    summary = IngestSummary("docs", failure_categories={})
    await _drain_pending(
        client, GdriveExecution("connection", 9, 1, "owner", "later", "scope", {}),
        Source(), Connection("docs", "gdrive"), state, progress.namespace, 9, summary, 1,
    )
    assert client.pushes == 0
    current = state.list_pending(progress.namespace, 9)
    assert len(current) == 1 and current[0].action == "remove"
    state.close()


@pytest.mark.asyncio
async def test_in_flight_remove_cannot_ack_newer_restoration_observation(tmp_path):
    state = StateStore(str(tmp_path / "in-flight-restoration.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 10, start_token="start",
    )
    snapshot = state.begin_selection_snapshot(
        progress.namespace, 10, [("doc", "file", "my-drive", False)],
    )
    state.publish_selection_snapshot(progress.namespace, 10, snapshot)
    state.record_membership(
        progress.namespace, 10, "doc", "doc", "my-drive", snapshot_id=snapshot,
    )
    state.materialize_page(
        progress.namespace, 10, "remove-page", "changes", "a", None, "b",
        [("doc", "remove", {"file_id": "doc"})], snapshot_id=snapshot,
        membership_removals=["doc"],
    )

    class Client:
        async def reconcile_gdrive(self, execution, **kwargs):
            state.materialize_page(
                progress.namespace, 10, "restore-page", "changes", "b", None, "c",
                [("doc", "upsert", {"file_id": "doc"})], snapshot_id=snapshot,
                membership_additions=[("doc", "doc", "my-drive")],
            )
            return {"items": 1}

    summary = IngestSummary("docs", failure_categories={})
    await _drain_pending(
        Client(), GdriveExecution("connection", 10, 1, "owner", "later", "scope", {}),
        object(), Connection("docs", "gdrive"), state, progress.namespace, 10, summary, 1,
    )
    current = state.list_pending(progress.namespace, 10)
    assert len(current) == 1 and current[0].action == "upsert"
    assert state.work_membership_current(current[0]) is True
    state.close()


def test_page_materialization_atomically_seeds_rescan_and_blocks_cursor_retirement(tmp_path):
    state = StateStore(str(tmp_path / "rescan-obligation.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 3, start_token="start",
    )
    active = state.begin_selection_snapshot(
        progress.namespace, 3, [("root", "folder", "my-drive", True)],
    )
    state.complete_traversal(
        progress.namespace, 3, "root", "root", None, snapshot_id=active,
    )
    state.publish_selection_snapshot(progress.namespace, 3, active)

    page = state.materialize_page(
        progress.namespace, 3, "changes:folder", "changes", "cursor", None, "terminal", [],
        snapshot_id=active,
        rescan_roots=[("root", "folder", "my-drive", True)],
    )
    assert page.rescan_snapshot_id and page.rescan_snapshot_id > active
    assert state.next_traversal(
        progress.namespace, 3, snapshot_id=page.rescan_snapshot_id,
    )["folder_id"] == "root"
    with pytest.raises(RuntimeError, match="subtree rescan"):
        state.commit_page(progress.namespace, 3, page.page_id, require_acks=False)
    state.complete_traversal(
        progress.namespace, 3, "root", "root", None,
        snapshot_id=page.rescan_snapshot_id,
    )
    state.publish_selection_snapshot(progress.namespace, 3, page.rescan_snapshot_id)
    state.commit_page(progress.namespace, 3, page.page_id, require_acks=False)
    assert state.get_page(progress.namespace, 3, page.page_id).committed_at
    state.close()


def test_replayed_change_page_repairs_original_rescan_without_new_incarnation(tmp_path):
    state = StateStore(str(tmp_path / "rescan-replay.sqlite"))
    key = StreamKey("team", "connection", "account", "my-drive")
    progress = state.begin_generation(key, 3, start_token="start", phase="current")
    roots = [("root", "folder", "my-drive", True)]
    active = state.begin_selection_snapshot(progress.namespace, 3, roots)
    state.complete_traversal(
        progress.namespace, 3, "root", "root", None, snapshot_id=active,
    )
    state.publish_selection_snapshot(progress.namespace, 3, active)

    page = state.materialize_page(
        progress.namespace, 3, "change:cursor", "changes", "cursor", None, "terminal",
        [], snapshot_id=active, rescan_roots=roots,
    )
    rescan = page.rescan_snapshot_id
    assert rescan is not None
    state.complete_traversal(
        progress.namespace, 3, "root", "root", None, snapshot_id=rescan,
    )
    state.publish_selection_snapshot(progress.namespace, 3, rescan)

    replay = state.materialize_page(
        progress.namespace, 3, "change:cursor", "changes", "cursor", None, "terminal",
        [], snapshot_id=active, rescan_roots=roots,
    )
    assert replay.rescan_snapshot_id == rescan
    current = state.get_progress(progress.namespace)
    assert current.active_snapshot == rescan and current.building_snapshot is None
    snapshot_count = state._db.execute(
        "SELECT count(*) FROM selection_snapshots WHERE namespace=? AND generation=?",
        (progress.namespace, 3),
    ).fetchone()[0]
    assert snapshot_count == 2
    state.close()


@pytest.mark.asyncio
async def test_missing_local_v2_checkpoint_forces_fresh_baseline_and_disables_absence(tmp_path):
    state = StateStore(str(tmp_path / "remote-recovery.sqlite"))
    start_calls = []

    class Changes:
        def getStartPageToken(self, **kwargs):
            start_calls.append(kwargs.get("driveId", "my-drive"))
            return _Request({"startPageToken": "fresh-recovery-start"})

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()

    class Client:
        revision = 7
        async def checkpoint_gdrive_execution(self, execution, progress):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": progress}

    remote = {
        "version": 2,
        "streams": {"my-drive": {
            "drive_id": "my-drive", "phase": "current", "listing_complete": True,
            "active_snapshot": 4, "baseline_start_token": "remote-start",
            "page_token": "remote-cursor", "checkpoint_id": "missing-page",
        }},
    }
    summary = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=Client(), execution=GdriveExecution(
            "connection", 5, 1, "owner", "later", "scope", {}, remote, 7,
        ), options={
            "credential_identity": "account", "selection_state": "selected",
            "folder_ids": ["folder"], "recursive": True,
        }, source=Source(), drive=Drive(), generation=5, drive_id="my-drive",
        namespace=StreamKey("team", "connection", "account", "my-drive").namespace(5),
        max_work=0,
    )
    progress = state.latest_progress_for_connection("connection")
    assert summary.failed == 0
    assert start_calls == ["my-drive"]
    assert progress.recovery_required is True
    assert progress.listing_complete is False and progress.active_snapshot is None
    assert progress.baseline_start_token == "fresh-recovery-start"
    state.close()


@pytest.mark.asyncio
async def test_remote_checkpoint_mismatch_preserves_prior_active_membership_during_recovery(tmp_path):
    state = StateStore(str(tmp_path / "remote-recovery-prior.sqlite"))
    key = StreamKey("team", "connection", "account", "my-drive")
    local = state.begin_generation(key, 5, start_token="old-start", phase="current")
    prior = state.begin_selection_snapshot(
        local.namespace, 5, [("folder", "folder", "my-drive", True)],
    )
    state.record_membership(
        local.namespace, 5, "still-authoritative", "folder", "my-drive", snapshot_id=prior,
    )
    state.complete_traversal(
        local.namespace, 5, "folder", "folder", None, snapshot_id=prior,
    )
    state.publish_selection_snapshot(local.namespace, 5, prior)

    class Changes:
        def getStartPageToken(self, **_kwargs):
            return _Request({"startPageToken": "fresh-recovery-start"})

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()

    class Client:
        async def checkpoint_gdrive_execution(self, execution, progress):
            return {"progress_revision": execution.progress_revision + 1, "progress": progress}

    remote = {
        "version": 2,
        "streams": {"my-drive": {
            "drive_id": "my-drive", "phase": "current", "listing_complete": True,
            "active_snapshot": 77, "baseline_start_token": "remote-start",
            "page_token": "remote-cursor", "checkpoint_id": "unknown-page",
        }},
    }
    summary = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=Client(), execution=GdriveExecution(
            "connection", 5, 1, "owner", "later", "scope", {}, remote, 7,
        ), options={
            "credential_identity": "account", "selection_state": "selected",
            "folder_ids": ["folder"], "recursive": True,
        }, source=Source(), drive=Drive(), generation=5, drive_id="my-drive",
        namespace=local.namespace, max_work=0,
    )
    progress = state.get_progress(local.namespace)
    assert summary.failed == 0 and progress.recovery_required is True
    assert progress.active_snapshot == prior and progress.building_snapshot != prior
    assert state.membership_ids(local.namespace, 5, snapshot_id=prior) == ["still-authoritative"]
    assert progress.page_token is None and progress.baseline_start_token == "fresh-recovery-start"
    state.close()


@pytest.mark.asyncio
async def test_stream_retry_not_before_blocks_manual_restart_until_fake_clock_advances(
    tmp_path, monkeypatch,
):
    state = StateStore(str(tmp_path / "retry-clock.sqlite"))
    key = StreamKey("team", "connection", "account", "my-drive")
    namespace = key.namespace(1)
    state.begin_generation(key, 1, start_token="start")
    state.update_progress(
        namespace, phase="current", page_token="cursor", listing_complete=True,
        retry_not_before="2026-09-22T12:01:00+00:00",
    )
    reads = []

    class Changes:
        def list(self, **kwargs):
            reads.append(kwargs["pageToken"])
            return _Request({"changes": [], "newStartPageToken": "terminal"})

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()

    class Client:
        revision = 0
        async def checkpoint_gdrive_execution(self, execution, progress):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": progress}

    monkeypatch.setattr("aios_ingest.gdrive_sync._now", lambda: "2026-09-22T12:00:00+00:00")
    args = dict(
        client=Client(), execution=GdriveExecution("connection", 1, 1, "owner", "later", "scope", {}),
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=1, drive_id="my-drive",
        namespace=namespace, max_work=10,
    )
    deferred = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        **args,
    )
    assert deferred.skipped == 1 and reads == []

    monkeypatch.setattr("aios_ingest.gdrive_sync._now", lambda: "2026-09-22T12:02:00+00:00")
    resumed = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        **args,
    )
    assert resumed.failed == 0 and reads == ["cursor"]
    state.close()


@pytest.mark.parametrize("header_key", ["Retry-After", "retry-after", "RETRY-AFTER"])
def test_retry_after_supports_httplib2_mapping_and_case_insensitive_numeric(header_key):
    class Error(Exception):
        resp = {"status": "429", header_key: "7"}

    assert GoogleDriveSource._retry_after(Error()) == 7


def test_retry_after_supports_header_container_http_date_and_rejects_invalid():
    future = datetime.now(timezone.utc) + timedelta(seconds=30)

    class Response:
        headers = {"rEtRy-AfTeR": format_datetime(future, usegmt=True)}

    class Error(Exception):
        response = Response()

    delay = GoogleDriveSource._retry_after(Error())
    assert delay is not None and 27 <= delay <= 30
    Error.response.headers["rEtRy-AfTeR"] = "not-a-delay"
    assert GoogleDriveSource._retry_after(Error()) is None


def test_stalled_provider_call_is_rejected_after_explicit_deadline(monkeypatch):
    ticks = iter([10.0, 10.1, 11.2])
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.monotonic", lambda: next(ticks))
    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1, provider_retry_attempts=2,
    )
    with pytest.raises(Exception) as raised:
        source._provider_call(lambda: {"late": True})
    assert type(raised.value).__name__ == "ProviderDeferred"
    assert raised.value.category == "provider_timeout"


def test_provider_call_tightens_real_transport_timeout_to_remaining_deadline(monkeypatch):
    ticks = iter([20.0, 20.25, 20.5, 20.6])
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.monotonic", lambda: next(ticks))

    class Socket:
        timeout = None
        def settimeout(self, value): self.timeout = value

    class Connection:
        timeout = None
        sock = Socket()

    class RawHttp:
        timeout = 30.0
        connections = {"google": Connection()}

    class Authorized:
        http = RawHttp()

    class Request:
        http = Authorized()
        def execute(self): return {"ok": True}

    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1,
    )
    request = Request()
    assert source._execute(request) == {"ok": True}
    assert request.http.http.timeout == pytest.approx(0.5)
    assert request.http.http.connections["google"].timeout == pytest.approx(0.5)
    assert request.http.http.connections["google"].sock.timeout == pytest.approx(0.5)


def test_metadata_docs_and_revision_requests_receive_explicit_reused_transport_timeout():
    observed = []

    class Socket:
        def settimeout(self, value): self.timeout = value

    class Connection:
        timeout = 30.0
        sock = Socket()

    class RawHttp:
        timeout = 30.0
        connections = {"google": Connection()}

    class Authorized:
        http = RawHttp()

    transport = Authorized()

    class Request:
        def __init__(self, label, value):
            self.label, self.value, self.http = label, value, transport
        def execute(self):
            observed.append((self.label, transport.http.timeout, Connection.sock.timeout))
            return self.value

    class Files:
        def get(self, **_kwargs):
            return Request("metadata", {
                "id": "doc", "name": "Doc", "mimeType": "application/vnd.google-apps.document",
                "modifiedTime": "2026-09-22T00:00:00Z",
            })

    class Revisions:
        def list(self, **_kwargs): return Request("revisions", {"revisions": []})

    class Drive:
        def files(self): return Files()
        def revisions(self): return Revisions()

    class Documents:
        def get(self, **_kwargs):
            return Request("docs", {
                "title": "Doc", "tabs": [{
                    "tabProperties": {"tabId": "root", "title": "Root"},
                    "documentTab": {"body": {"content": [_paragraph("body\n")]}}
                }],
            })

    class Docs:
        def documents(self): return Documents()

    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=Drive(), docs_service=Docs(),
        request_deadline_seconds=5,
    )
    meta = source._metadata("doc")
    assert source._raw_doc(meta).external_id == "doc"
    assert [label for label, *_ in observed] == ["metadata", "docs", "revisions"]
    assert all(0 < timeout <= 5 for _, timeout, _ in observed)
    assert all(socket_timeout == timeout for _, timeout, socket_timeout in observed)


def test_local_credential_transport_has_explicit_request_timeout():
    AnonymousCredentials = pytest.importorskip("google.auth.credentials").AnonymousCredentials
    transport = _credential_authorized_http(AnonymousCredentials(), timeout_seconds=2.5)
    assert transport.http.timeout == pytest.approx(2.5)


class _RecordingSocket:
    def __init__(self):
        self.timeouts = []

    def settimeout(self, value):
        self.timeouts.append(value)


class _RecordingWireResponse(dict):
    def __init__(self, status=200, *, content=b"{}", on_read=None, **headers):
        super().__init__(status=str(status), **headers)
        self._content = content
        self._on_read = on_read

    def read(self):
        if self._on_read is not None:
            self._on_read()
        return self._content


class _RecordingHttplibConnection:
    def __init__(self, host="drive.example", timeout=30.0, proxy_info=None):
        self.host = host
        self.timeout = timeout
        self.proxy_info = proxy_info
        self.sock = None
        self.connect_timeouts = []
        self.request_timeouts = []
        self.responses = [_RecordingWireResponse()]
        self.on_connect = None
        self.on_request = None

    def set_debuglevel(self, _level):
        return None

    def connect(self):
        self.connect_timeouts.append(self.timeout)
        if self.on_connect is not None:
            self.on_connect()
        self.sock = _RecordingSocket()

    def request(self, method, uri, body=None, headers=None):
        self.request_timeouts.append(self.timeout)
        if self.on_request is not None:
            self.on_request()

    def getresponse(self):
        return self.responses.pop(0)

    def close(self):
        self.sock = None


def test_service_account_connection_refuses_expired_connect_without_dispatch():
    httplib2 = pytest.importorskip("httplib2")
    clock = [1.1]
    raw = httplib2.Http(timeout=30.0)
    transport = _AbsoluteDeadlineHttp(raw, monotonic=lambda: clock[0])
    transport.set_deadline(1.0)
    connection = _RecordingHttplibConnection()

    with pytest.raises(ProviderDeferred) as raised:
        raw._conn_request(connection, "/files", "GET", None, {})

    assert raised.value.category == "provider_timeout"
    assert connection.connect_timeouts == []
    assert connection.request_timeouts == []


def test_service_account_connection_connect_uses_actual_remaining_deadline():
    httplib2 = pytest.importorskip("httplib2")
    clock = [0.4]
    raw = httplib2.Http(timeout=30.0)
    transport = _AbsoluteDeadlineHttp(raw, monotonic=lambda: clock[0])
    transport.set_deadline(1.0)
    connection = _RecordingHttplibConnection()

    response, content = raw._conn_request(connection, "/files", "GET", None, {})

    assert response.status == 200
    assert content == b"{}"
    assert connection.connect_timeouts == pytest.approx([0.6])
    assert connection.request_timeouts == pytest.approx([0.6])
    assert connection.sock.timeouts == pytest.approx([0.6])


def test_service_account_connect_completion_cannot_allow_expired_payload():
    httplib2 = pytest.importorskip("httplib2")
    clock = [0.4]
    raw = httplib2.Http(timeout=30.0)
    transport = _AbsoluteDeadlineHttp(raw, monotonic=lambda: clock[0])
    transport.set_deadline(1.0)
    connection = _RecordingHttplibConnection()
    connection.on_connect = lambda: clock.__setitem__(0, 1.1)

    with pytest.raises(ProviderDeferred) as raised:
        raw._conn_request(connection, "/files", "GET", None, {})

    assert raised.value.category == "provider_timeout"
    assert connection.connect_timeouts == pytest.approx([0.6])
    assert connection.request_timeouts == []


def test_service_account_stale_retry_keeps_original_deadline():
    httplib2 = pytest.importorskip("httplib2")
    clock = [0.2]
    raw = httplib2.Http(timeout=30.0)
    transport = _AbsoluteDeadlineHttp(raw, monotonic=lambda: clock[0])
    transport.set_deadline(1.0)
    connection = _RecordingHttplibConnection()

    def fail_stale_response():
        clock[0] = 1.1
        raise http.client.BadStatusLine("stale connection")

    connection.getresponse = fail_stale_response
    with pytest.raises(ProviderDeferred) as raised:
        raw._conn_request(connection, "/files", "GET", None, {})

    assert raised.value.category == "provider_timeout"
    assert transport._deadline == 1.0
    assert connection.connect_timeouts == pytest.approx([0.8])
    assert connection.request_timeouts == pytest.approx([0.8])


def test_service_account_redirect_reconnect_checks_original_deadline():
    httplib2 = pytest.importorskip("httplib2")
    clock = [0.2]
    created = []

    class RedirectConnection(_RecordingHttplibConnection):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            created.append(self)
            self.responses = [_RecordingWireResponse(
                302,
                location="http://drive.example/redirected",
                on_read=self._expire_and_disconnect,
            )]

        def _expire_and_disconnect(self):
            clock[0] = 1.1
            self.sock = None

    raw = httplib2.Http(timeout=30.0)
    transport = _AbsoluteDeadlineHttp(raw, monotonic=lambda: clock[0])
    transport.set_deadline(1.0)

    with pytest.raises(ProviderDeferred) as raised:
        transport.request("http://drive.example/start", connection_type=RedirectConnection)

    connection = created[0]
    assert raised.value.category == "provider_timeout"
    assert transport._deadline == 1.0
    assert connection.connect_timeouts == pytest.approx([0.8])
    assert connection.request_timeouts == pytest.approx([0.8])


def test_service_account_refresh_cannot_dispatch_after_absolute_deadline(monkeypatch):
    Credentials = pytest.importorskip("google.auth.credentials").Credentials
    httplib2 = pytest.importorskip("httplib2")
    clock = [0.0]
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.monotonic", lambda: clock[0])

    class RawHttp:
        timeout = 30.0
        connections = {}
        calls = []
        def request(self, uri, method="GET", **_kwargs):
            self.calls.append(uri)
            return httplib2.Response({"status": "200"}), b"{}"

    class ControlledCredentials(Credentials):
        def refresh(self, request):
            clock[0] = 1.1
            request("https://oauth.example/token")

    raw = RawHttp()
    transport = _credential_authorized_http(
        ControlledCredentials(), http=raw, timeout_seconds=1,
    )
    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1,
    )
    with pytest.raises(ProviderDeferred) as raised:
        source._provider_call(
            lambda: transport.request("https://drive.example/files"), transport=transport,
        )
    assert raised.value.category == "provider_timeout"
    assert raw.calls == []


def test_service_account_refresh_and_provider_share_one_shrinking_deadline(monkeypatch):
    Credentials = pytest.importorskip("google.auth.credentials").Credentials
    httplib2 = pytest.importorskip("httplib2")
    clock = [0.0]
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.monotonic", lambda: clock[0])

    class Socket:
        timeout = None
        def settimeout(self, value): self.timeout = value

    class Connection:
        timeout = None
        sock = Socket()

    class RawHttp:
        timeout = 30.0
        connections = {"reused": Connection()}
        calls = []
        def request(self, uri, method="GET", **_kwargs):
            self.calls.append((uri, self.timeout, self.connections["reused"].sock.timeout))
            return httplib2.Response({"status": "200"}), b"{}"

    class ControlledCredentials(Credentials):
        def refresh(self, request):
            clock[0] = 0.2
            request("https://oauth.example/assertion")
            clock[0] = 0.5
            request("https://oauth.example/token")
            self.token = "service-token"
            clock[0] = 0.7

    raw = RawHttp()
    transport = _credential_authorized_http(
        ControlledCredentials(), http=raw, timeout_seconds=1,
    )
    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1,
    )
    response, _ = source._provider_call(
        lambda: transport.request("https://drive.example/files"), transport=transport,
    )
    assert response.status == 200
    assert [uri for uri, *_ in raw.calls] == [
        "https://oauth.example/assertion", "https://oauth.example/token",
        "https://drive.example/files",
    ]
    assert [timeout for _, timeout, _ in raw.calls] == pytest.approx([0.8, 0.5, 0.3])
    assert [timeout for _, _, timeout in raw.calls] == pytest.approx([0.8, 0.5, 0.3])


def test_service_account_internal_401_replay_cannot_extend_deadline(monkeypatch):
    Credentials = pytest.importorskip("google.auth.credentials").Credentials
    httplib2 = pytest.importorskip("httplib2")
    clock = [0.0]
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.monotonic", lambda: clock[0])

    class RawHttp:
        timeout = 30.0
        connections = {}
        calls = []
        provider_calls = 0
        def request(self, uri, method="GET", **_kwargs):
            self.calls.append(uri)
            if "drive.example" in uri:
                self.provider_calls += 1
                if self.provider_calls == 1:
                    clock[0] = 0.4
                    return httplib2.Response({"status": "401"}), b"expired"
            return httplib2.Response({"status": "200"}), b"{}"

    class ControlledCredentials(Credentials):
        def __init__(self):
            super().__init__()
            self.token = "initial-token"
        def refresh(self, request):
            clock[0] = 0.6
            request("https://oauth.example/token")
            self.token = "replacement-token"
            clock[0] = 1.1

    raw = RawHttp()
    transport = _credential_authorized_http(
        ControlledCredentials(), http=raw, timeout_seconds=1,
    )
    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1,
    )
    with pytest.raises(ProviderDeferred) as raised:
        source._provider_call(
            lambda: transport.request("https://drive.example/files"), transport=transport,
        )
    assert raised.value.category == "provider_timeout"
    assert raw.calls == ["https://drive.example/files", "https://oauth.example/token"]
    assert raw.provider_calls == 1


def test_request_factory_rebuilds_with_shrinking_timeout_on_near_deadline_retry(monkeypatch):
    ticks = iter([0.0, 0.1, 0.2, 0.5, 0.6, 0.7, 0.8])
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.monotonic", lambda: next(ticks))
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.sleep", lambda _delay: None)
    monkeypatch.setattr("aios_ingest.sources.gdrive.random.uniform", lambda _a, _b: 0.0)
    timeouts = []
    attempts = 0

    class RawHttp:
        timeout = 30.0
        connections = {}

    class Authorized:
        http = RawHttp()

    class Request:
        http = Authorized()
        def execute(self):
            nonlocal attempts
            attempts += 1
            timeouts.append(self.http.http.timeout)
            if attempts == 1:
                raise TimeoutError("first attempt")
            return {"ok": True}

    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1, provider_retry_attempts=2,
    )
    assert source._request(Request) == {"ok": True}
    assert timeouts == pytest.approx([0.8, 0.3])


@pytest.mark.parametrize("stage", ["token", "authority", "request"])
def test_provider_never_executes_when_preparation_exhausts_deadline(monkeypatch, stage):
    ticks = iter([0.0, 0.1, 1.2])
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.monotonic", lambda: next(ticks))
    executed = []

    class Provider:
        access_token = "memory"
        scopes = []
        def ensure_valid(self): pass

    class Request:
        http = None
        def execute(self):
            executed.append(True)
            return {"unsafe": True}

    kwargs = {}
    if stage == "token":
        kwargs["token_provider"] = Provider()
    elif stage == "authority":
        kwargs["provider_gate"] = lambda: None

    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1, **kwargs,
    )
    with pytest.raises(ProviderDeferred, match=f"during {'token validation' if stage == 'token' else 'authority validation' if stage == 'authority' else 'request construction'}"):
        source._request(Request)
    assert executed == []


def test_service_account_style_request_uses_post_construction_remaining_timeout(monkeypatch):
    ticks = iter([5.0, 5.1, 5.7, 5.8])
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.monotonic", lambda: next(ticks))
    observed = []

    class RawHttp:
        timeout = 30.0
        connections = {}

    class Transport:
        http = RawHttp()

    class Request:
        http = Transport()
        def execute(self):
            observed.append(self.http.http.timeout)
            return {"ok": True}

    source = GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=1,
    )
    assert source._request(Request) == {"ok": True}
    assert observed == pytest.approx([0.3])


@pytest.mark.asyncio
async def test_cursor_checkpoint_crash_stays_partial_then_restart_finishes_all_work(tmp_path, monkeypatch):
    path = tmp_path / "cursor-crash.sqlite"
    state = StateStore(str(path))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 13, start_token="start", phase="current",
    )
    snapshot = state.begin_selection_snapshot(
        progress.namespace, 13, [("doc", "file", "my-drive", False)],
    )
    state.publish_selection_snapshot(progress.namespace, 13, snapshot)
    state.update_progress(
        progress.namespace, page_token="cursor", listing_complete=True,
        last_success_at="2026-09-21T00:00:00+00:00",
    )
    page = state.materialize_page(
        progress.namespace, 13, "terminal-page", "changes", "cursor", None, "terminal-1",
        [("doc", "upsert", {"file_id": "doc"})], snapshot_id=snapshot,
        membership_additions=[("doc", "direct", "my-drive")],
    )

    class Client:
        revision = 0
        progress = {}
        pushes = 0
        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            self.progress = payload
            return {"progress_revision": self.revision, "progress": payload}
        async def push(self, payload, *, execution):
            self.pushes += 1
            return IngestResult("created", "item", payload.path)

    class MalformedSource:
        def _metadata(self, file_id): return {"id": file_id}
        def _raw_doc(self, meta): raise IncompleteExtractionError("not yet readable")

    client = Client()
    execution = GdriveExecution("connection", 13, 1, "owner", "later", "scope", {})
    original_commit = state.commit_page
    monkeypatch.setattr(state, "commit_page", lambda *_args, **_kwargs: (_ for _ in ()).throw(
        RuntimeError("crash after server cursor ack")
    ))
    with pytest.raises(RuntimeError, match="crash after server cursor ack"):
        await _finish_materialized_pages(
            client, execution, MalformedSource(), Connection("docs", "gdrive"), state,
            progress.namespace, 13, IngestSummary("docs", failure_categories={}), 1,
        )
    assert client.progress["phase"] == "partial"
    assert client.progress["last_success_at"] == "2026-09-21T00:00:00+00:00"
    assert state.get_page(progress.namespace, 13, page.page_id).committed_at is None
    monkeypatch.setattr(state, "commit_page", original_commit)
    state.close()

    state = StateStore(str(path))
    state._db.execute(
        "UPDATE pending_work SET not_before=NULL WHERE namespace=?", (progress.namespace,),
    )
    state._db.commit()

    class Source:
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id):
            return {"id": file_id, "mimeType": "application/vnd.google-apps.document"}
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], body="recovered")

    class Changes:
        def list(self, **_kwargs):
            return _Request({"changes": [], "newStartPageToken": "terminal-2"})

    class Drive:
        def changes(self): return Changes()

    resumed_execution = GdriveExecution(
        "connection", 13, 1, "owner-2", "later", "scope", {},
        progress=client.progress, progress_revision=client.revision,
    )
    result = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=resumed_execution,
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=13, drive_id="my-drive",
        namespace=progress.namespace, max_work=2,
    )
    assert result.created == 1 and client.pushes == 1
    assert state.get_page(progress.namespace, 13, page.page_id).committed_at is not None
    assert state.get_page(progress.namespace, 13, page.page_id).drain_observation == 0
    later_pages = state._db.execute(
        "SELECT drain_observation,input_token FROM materialized_pages "
        "WHERE namespace=? AND generation=? AND page_kind='changes' AND page_id<>?",
        (progress.namespace, 13, page.page_id),
    ).fetchall()
    assert [(row[0], row[1]) for row in later_pages] == [(1, "terminal-1")]
    assert state.pending_count(progress.namespace, 13) == 0
    ready = state.get_progress(progress.namespace)
    assert ready.phase == "partial"
    assert ready.last_success_at == "2026-09-21T00:00:00+00:00"
    await _checkpoint_complete_if_clean(
        client, resumed_execution, state, progress.namespace, 13, finalize=True,
    )
    finished = state.get_progress(progress.namespace)
    assert finished.phase == "current" and finished.last_error is None
    assert finished.last_success_at != "2026-09-21T00:00:00+00:00"
    state.close()


@pytest.mark.asyncio
async def test_terminal_drain_evidence_survives_restart_and_blocks_early_success(tmp_path):
    path = tmp_path / "terminal-drain.sqlite"
    state = StateStore(str(path))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account", "drive-a"), 14,
        start_token="start", phase="current",
    )
    snapshot = state.begin_selection_snapshot(
        progress.namespace, 14, [("doc", "file", "drive-a", False)],
    )
    state.publish_selection_snapshot(progress.namespace, 14, snapshot)
    state.record_membership(
        progress.namespace, 14, "doc", "doc", "drive-a", snapshot_id=snapshot,
    )
    state.update_progress(
        progress.namespace, listing_complete=True, page_token="page-1",
        last_success_at="2026-09-20T00:00:00+00:00",
    )

    pages = [{"changes": [], "nextPageToken": "page-2"}]

    class Changes:
        def list(self, **_kwargs): return _Request(pages.pop(0))

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id):
            return {"id": file_id, "mimeType": "application/vnd.google-apps.document", "driveId": "drive-a"}
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], body="changed")

    class Client:
        revision = 0
        pushed = []
        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": payload}
        async def push(self, payload, *, execution):
            self.pushed.append(payload.frontmatter["source_id"])
            return IngestResult("updated", "item", payload.path)

    client = Client()
    execution = GdriveExecution("connection", 14, 1, "owner", "later", "scope", {})
    await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=execution,
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=14, drive_id="drive-a",
        namespace=progress.namespace, max_work=0, discovery_budget=1, retry_budget=0,
    )
    catching_up = state.get_progress(progress.namespace)
    assert catching_up.page_token == "page-2"
    assert catching_up.phase == "catching_up"
    assert catching_up.terminal_drain_acknowledged is False
    assert catching_up.last_success_at == "2026-09-20T00:00:00+00:00"
    state.close()

    pages.append({"changes": [], "newStartPageToken": "terminal"})
    state = StateStore(str(path))
    second_execution = GdriveExecution(
        "connection", 14, 1, "owner-2", "later", "scope", {},
        progress=execution.progress, progress_revision=client.revision,
    )
    await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=second_execution,
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=14, drive_id="drive-a",
        namespace=progress.namespace, max_work=0, discovery_budget=1, retry_budget=0,
    )
    drained = state.get_progress(progress.namespace)
    assert drained.phase == "partial"
    assert drained.terminal_drain_acknowledged is True
    assert drained.terminal_drain_token == drained.page_token == "terminal"
    assert drained.terminal_drain_checkpoint_id == drained.checkpoint_id
    assert drained.terminal_drain_observation == drained.drain_observation == 1
    assert drained.last_success_at == "2026-09-20T00:00:00+00:00"
    await _checkpoint_complete_if_clean(
        client, second_execution, state, progress.namespace, 14, finalize=True,
    )
    assert state.get_progress(progress.namespace).phase == "current"

    # Polling a terminal token is a new observation even when Google returns the same terminal
    # token. A later edit from that same input token must therefore materialize and execute.
    pages.append({"changes": [], "newStartPageToken": "terminal"})
    await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=second_execution,
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=14, drive_id="drive-a",
        namespace=progress.namespace, max_work=0, discovery_budget=1, retry_budget=0,
    )
    second_drain = state.get_progress(progress.namespace)
    assert second_drain.drain_observation == second_drain.terminal_drain_observation == 2

    pages.append({
        "changes": [{"fileId": "doc", "file": {
            "id": "doc", "mimeType": "application/vnd.google-apps.document",
            "driveId": "drive-a", "parents": [],
        }}],
        "newStartPageToken": "terminal-later",
    })
    result = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=second_execution,
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=14, drive_id="drive-a",
        namespace=progress.namespace, max_work=1, discovery_budget=1, retry_budget=0,
    )
    third_drain = state.get_progress(progress.namespace)
    assert result.updated == 1 and client.pushed == ["doc"]
    assert third_drain.drain_observation == third_drain.terminal_drain_observation == 3
    observations = state._db.execute(
        "SELECT drain_observation,input_token,terminal_token FROM materialized_pages "
        "WHERE namespace=? AND generation=? AND page_kind='changes' ORDER BY drain_observation,input_token",
        (progress.namespace, 14),
    ).fetchall()
    assert [(row[0], row[1], row[2]) for row in observations] == [
        (1, "page-1", None), (1, "page-2", "terminal"),
        (2, "terminal", "terminal"), (3, "terminal", "terminal-later"),
    ]
    state.close()


@pytest.mark.asyncio
async def test_crash_after_change_materialization_reuses_observation_then_advances(tmp_path, monkeypatch):
    path = tmp_path / "observation-crash.sqlite"
    state = StateStore(str(path))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account", "my-drive"), 15,
        start_token="terminal", phase="current",
    )
    snapshot = state.begin_selection_snapshot(progress.namespace, 15, [])
    state.publish_selection_snapshot(progress.namespace, 15, snapshot)
    state.update_progress(progress.namespace, listing_complete=True, page_token="terminal")
    provider_calls = []

    class Changes:
        def list(self, **kwargs):
            provider_calls.append(kwargs["pageToken"])
            return _Request({"changes": [], "newStartPageToken": "terminal"})

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()

    class Client:
        revision = 0
        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": payload}

    client = Client()
    execution = GdriveExecution("connection", 15, 1, "owner", "later", "scope", {})
    original_materialize = state.materialize_page

    def crash_after_materialize(*args, **kwargs):
        original_materialize(*args, **kwargs)
        raise RuntimeError("crash after page materialization")

    monkeypatch.setattr(state, "materialize_page", crash_after_materialize)
    with pytest.raises(RuntimeError, match="page materialization"):
        await _run_gdrive_stream_unlocked(
            BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
            client=client, execution=execution,
            options={"credential_identity": "account", "selection_state": "selected"},
            source=Source(), drive=Drive(), generation=15, drive_id="my-drive",
            namespace=progress.namespace, max_work=0, discovery_budget=1, retry_budget=0,
        )
    uncommitted = state.next_uncommitted_page(progress.namespace, 15)
    assert uncommitted is not None and uncommitted.drain_observation == 1
    assert provider_calls == ["terminal"]
    monkeypatch.setattr(state, "materialize_page", original_materialize)
    state.close()

    state = StateStore(str(path))
    resumed = GdriveExecution(
        "connection", 15, 1, "owner-2", "later", "scope", {},
        progress=execution.progress, progress_revision=client.revision,
    )
    await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=resumed,
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=15, drive_id="my-drive",
        namespace=progress.namespace, max_work=0, discovery_budget=1, retry_budget=0,
    )
    recovered = state.get_progress(progress.namespace)
    assert provider_calls == ["terminal", "terminal"]
    assert recovered.drain_observation == recovered.terminal_drain_observation == 2
    assert state.next_uncommitted_page(progress.namespace, 15) is None
    assert [row[0] for row in state._db.execute(
        "SELECT drain_observation FROM materialized_pages WHERE namespace=? AND generation=? "
        "ORDER BY drain_observation",
        (progress.namespace, 15),
    ).fetchall()] == [1, 2]

    await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=resumed,
        options={"credential_identity": "account", "selection_state": "selected"},
        source=Source(), drive=Drive(), generation=15, drive_id="my-drive",
        namespace=progress.namespace, max_work=0, discovery_budget=1, retry_budget=0,
    )
    assert provider_calls == ["terminal", "terminal", "terminal"]
    assert state.get_progress(progress.namespace).drain_observation == 3
    state.close()



@pytest.mark.asyncio
async def test_malformed_first_listing_page_does_not_block_later_page_or_snapshot_completion(tmp_path):
    state = StateStore(str(tmp_path / "malformed-multipage.sqlite"))
    key = StreamKey("team", "connection", "account", "my-drive")
    namespace = key.namespace(12)
    pages = [
        {"files": [{
            "id": "bad", "name": "Bad", "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-09-22T00:00:00Z", "parents": ["folder"],
        }], "nextPageToken": "p2"},
        {"files": [{
            "id": "good", "name": "Good", "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-09-22T00:00:01Z", "parents": ["folder"],
        }]},
    ]

    class Files:
        calls = []
        def list(self, **kwargs):
            self.calls.append(kwargs.get("pageToken"))
            return _Request(pages.pop(0))

    class Changes:
        def getStartPageToken(self, **kwargs): return _Request({"startPageToken": "start"})
        def list(self, **kwargs): return _Request({"changes": [], "newStartPageToken": "terminal"})

    class Drive:
        def __init__(self): self.file_api = Files()
        def files(self): return self.file_api
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()
        def _raw_doc(self, meta):
            if meta["id"] == "bad":
                raise IncompleteExtractionError("malformed")
            return RawDoc(source="gdrive", external_id=meta["id"], body="good")
        def _metadata(self, file_id):
            return {
                "id": file_id, "name": file_id.title(),
                "mimeType": "application/vnd.google-apps.document",
                "modifiedTime": "2026-09-22T00:00:01Z", "parents": ["folder"],
            }

    class Client:
        pushed, revision = [], 0
        async def push(self, payload, *, execution):
            self.pushed.append(payload.frontmatter["source_id"])
            return IngestResult("created", "item", payload.path)
        async def checkpoint_gdrive_execution(self, execution, progress):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": progress}

    client, drive = Client(), Drive()
    summary = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=GdriveExecution("connection", 12, 1, "owner", "later", "scope", {}),
        options={
            "credential_identity": "account", "selection_state": "selected",
            "folder_ids": ["folder"], "recursive": True,
        }, source=Source(), drive=drive, generation=12, drive_id="my-drive",
        namespace=namespace, max_work=1, discovery_budget=2, retry_budget=1,
    )
    progress = state.get_progress(namespace)
    assert summary.failed == 1 and summary.created == 0
    assert client.pushed == []
    assert drive.file_api.calls == [None, "p2"]
    assert progress.listing_complete is True and progress.active_snapshot is not None
    assert progress.phase == "partial"
    assert {work.item_key for work in state.list_pending(namespace, 12)} == {"good"}

    second = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=GdriveExecution(
            "connection", 12, 1, "owner-2", "later", "scope", {},
            progress={}, progress_revision=client.revision,
        ), options={
            "credential_identity": "account", "selection_state": "selected",
            "folder_ids": ["folder"], "recursive": True,
        }, source=Source(), drive=drive, generation=12, drive_id="my-drive",
        namespace=namespace, max_work=1, discovery_budget=1, retry_budget=1,
    )
    assert second.created == 1 and client.pushed == ["good"]
    state.close()


# ---------------------------------------------------------------------------------------------
# Shared fakes for the coordinator tests below
# ---------------------------------------------------------------------------------------------

_DOC_MIME = "application/vnd.google-apps.document"
_FOLDER_MIME = "application/vnd.google-apps.folder"


class _RecordingBrain:
    """Brain fake: records every push and removal, and acknowledges every checkpoint."""

    def __init__(self):
        self.pushed, self.removed, self.revision = [], [], 0

    async def push(self, payload, *, execution):
        self.pushed.append(payload.frontmatter["source_id"])
        return IngestResult("created", "item", payload.path)

    async def reconcile_gdrive(self, execution, **kwargs):
        self.removed.extend(kwargs.get("removed_provider_ids") or [])
        return {"items": len(kwargs.get("removed_provider_ids") or [])}

    async def checkpoint_gdrive_execution(self, execution, progress):
        self.revision += 1
        return {"progress_revision": self.revision, "progress": progress}


def _pending_rows(state, namespace):
    return [
        (row["item_key"], row["attempts"], row["not_before"], row["last_error"])
        for row in state._db.execute(
            "select item_key,attempts,not_before,last_error from pending_work "
            "where namespace=? and acknowledged_at is null order by item_key",
            (namespace,),
        ).fetchall()
    ]


# ---------------------------------------------------------------------------------------------
# A document that cannot be normalized is that document's failure
# ---------------------------------------------------------------------------------------------


def test_document_that_cannot_be_normalized_is_a_durable_failure_and_its_siblings_still_run(tmp_path):
    path = tmp_path / "unnormalizable.sqlite"
    state = StateStore(str(path))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 1, start_token="start",
    )
    state.enqueue_work(progress.namespace, 1, "a-huge", "upsert")
    state.enqueue_work(progress.namespace, 1, "b-good", "upsert")
    marker = "CONFIDENTIAL-BODY-TEXT"

    class Source:
        def _metadata(self, file_id): return {"id": file_id}
        def _raw_doc(self, meta):
            # Over the item contract's body limit: normalization itself refuses the document.
            body = marker + "x" * 1_000_000 if meta["id"] == "a-huge" else "good"
            return RawDoc(source="gdrive", external_id=meta["id"], body=body)

    client = _RecordingBrain()
    summary = IngestSummary("docs", failure_categories={})
    # The run does not crash on the first document: the second is still read and pushed.
    asyncio.run(_drain_pending(
        client, GdriveExecution("connection", 1, 1, "owner", "later", "scope", {}),
        Source(), Connection("docs", "gdrive"), state, progress.namespace, 1, summary, 10,
    ))

    assert summary.failed == 1 and summary.created == 1
    assert summary.failure_categories == {"invalid_payload": 1}
    assert client.pushed == ["b-good"]
    ((item_key, attempts, not_before, last_error),) = _pending_rows(state, progress.namespace)
    assert (item_key, attempts) == ("a-huge", 1)
    assert not_before
    # The diagnosis names the field and the rule, and carries none of the document's text.
    assert last_error == "invalid item payload: body (string_too_long)"
    assert marker not in last_error
    state.close()

    restarted = StateStore(str(path))
    assert restarted.pending_count(progress.namespace, 1) == 1
    restarted.close()


# ---------------------------------------------------------------------------------------------
# Sink and reconcile calls observe the run's absolute deadline, and defer safely
# ---------------------------------------------------------------------------------------------


def test_run_deadline_is_reached_only_at_or_after_the_executions_absolute_instant():
    execution = GdriveExecution("connection", 1, 1, "owner", "later", "scope", {})
    assert _run_deadline_reached(execution) is False
    assert _run_deadline_reached(
        dataclasses.replace(execution, run_deadline=time.monotonic() + 3600)
    ) is False
    assert _run_deadline_reached(
        dataclasses.replace(execution, run_deadline=time.monotonic() - 1)
    ) is True


def test_expired_run_deadline_starts_no_provider_or_sink_work_and_fails_nothing(tmp_path):
    state = StateStore(str(tmp_path / "deadline-expired.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 1, start_token="start",
    )
    state.enqueue_work(progress.namespace, 1, "a", "upsert")
    state.enqueue_work(progress.namespace, 1, "b", "upsert")
    state.enqueue_work(progress.namespace, 1, "c", "remove")

    class Source:
        reads = []
        def _metadata(self, file_id):
            self.reads.append(file_id)
            return {"id": file_id}
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], body="body")

    client, source = _RecordingBrain(), Source()
    summary = IngestSummary("docs", failure_categories={})
    execution = GdriveExecution(
        "connection", 1, 1, "owner", "later", "scope", {}, run_deadline=time.monotonic() - 1,
    )
    consumed = asyncio.run(_drain_pending(
        client, execution, source, Connection("docs", "gdrive"), state,
        progress.namespace, 1, summary, 10,
    ))

    assert consumed == 0
    assert source.reads == [] and client.pushed == [] and client.removed == []
    assert summary.failed == 0 and summary.failure_categories == {"run_deadline": 1}
    # Out of time is not a failed attempt: nothing was charged or pushed back.
    assert _pending_rows(state, progress.namespace) == [
        ("a", 0, None, None), ("b", 0, None, None), ("c", 0, None, None),
    ]
    state.close()


def test_sink_call_stopped_by_the_run_deadline_leaves_its_work_untouched_and_starts_nothing_else(
    tmp_path,
):
    state = StateStore(str(tmp_path / "deadline-mid-run.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 1, start_token="start",
    )
    for item in ("a", "b", "c"):
        state.enqueue_work(progress.namespace, 1, item, "upsert")

    class Source:
        reads = []
        def _metadata(self, file_id):
            self.reads.append(file_id)
            return {"id": file_id}
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], body="body")

    class Client(_RecordingBrain):
        async def push(self, payload, *, execution):
            # The deadline arrives while this document is at the sink: the brain client refuses
            # to start (or wait for) the request instead of sleeping past it.
            self.pushed.append(payload.frontmatter["source_id"])
            raise BrainDeferred(503, "run_deadline", "run deadline reached before the brain request was sent")

    client, source = Client(), Source()
    summary = IngestSummary("docs", failure_categories={})
    asyncio.run(_drain_pending(
        client, GdriveExecution("connection", 1, 1, "owner", "later", "scope", {}),
        source, Connection("docs", "gdrive"), state, progress.namespace, 1, summary, 10,
    ))

    # `b` and `c` were never read from Drive: nothing is started once the sink is out of time.
    assert client.pushed == ["a"] and source.reads == ["a"]
    assert summary.failed == 0 and summary.failure_categories == {"run_deadline": 1}
    assert _pending_rows(state, progress.namespace) == [
        ("a", 0, None, None), ("b", 0, None, None), ("c", 0, None, None),
    ]
    state.close()


def test_sink_wait_the_brain_named_beyond_the_deadline_is_kept_as_the_retry_time_and_ends_the_drain(
    tmp_path,
):
    state = StateStore(str(tmp_path / "deadline-retry-after.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 1, start_token="start",
    )
    state.enqueue_work(progress.namespace, 1, "a", "upsert")
    state.enqueue_work(progress.namespace, 1, "b", "upsert")
    retry_at = "2099-01-01T00:00:00+00:00"

    class Source:
        reads = []
        def _metadata(self, file_id):
            self.reads.append(file_id)
            return {"id": file_id}
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], body="body")

    class Client(_RecordingBrain):
        async def push(self, payload, *, execution):
            # The brain is rate limiting, and the wait it names does not fit the run.
            self.pushed.append(payload.frontmatter["source_id"])
            raise BrainDeferred(429, "rate_limited", "wait", not_before=retry_at)

    client, source = Client(), Source()
    summary = IngestSummary("docs", failure_categories={})
    asyncio.run(_drain_pending(
        client, GdriveExecution("connection", 1, 1, "owner", "later", "scope", {}),
        source, Connection("docs", "gdrive"), state, progress.namespace, 1, summary, 10,
    ))

    # One refused attempt, remembered with the brain's own retry time — and `b` is not sent into
    # the same closed limit, nor even read from Drive, to be charged a failure of its own.
    assert client.pushed == ["a"] and source.reads == ["a"]
    assert summary.failed == 1 and summary.failure_categories == {"rate_limited": 1}
    rows = _pending_rows(state, progress.namespace)
    assert [(key, attempts, not_before) for key, attempts, not_before, _error in rows] == [
        ("a", 1, retry_at), ("b", 0, None),
    ]
    state.close()


def test_reconcile_call_stopped_by_the_run_deadline_keeps_the_removal_obligation_untouched(tmp_path):
    state = StateStore(str(tmp_path / "deadline-remove.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 1, start_token="start",
    )
    state.enqueue_work(progress.namespace, 1, "gone", "remove", {"file_id": "gone"})

    class Client(_RecordingBrain):
        async def reconcile_gdrive(self, execution, **kwargs):
            raise BrainDeferred(503, "run_deadline", "run deadline reached before the brain request was admitted")

    summary = IngestSummary("docs", failure_categories={})
    asyncio.run(_drain_pending(
        Client(), GdriveExecution("connection", 1, 1, "owner", "later", "scope", {}),
        object(), Connection("docs", "gdrive"), state, progress.namespace, 1, summary, 10,
    ))

    assert summary.failed == 0 and summary.removed == 0
    assert summary.failure_categories == {"run_deadline": 1}
    assert _pending_rows(state, progress.namespace) == [("gone", 0, None, None)]
    state.close()


@pytest.mark.asyncio
async def test_deferred_all_stream_reconciliation_is_not_a_failure_and_completes_on_the_next_run(
    tmp_path, monkeypatch,
):
    integration_id = "00000000-0000-0000-0000-000000000029"
    deadlines = []

    class Changes:
        def getStartPageToken(self, **kwargs):
            return _Request({"startPageToken": f"start:{kwargs.get('driveId')}"})

    class Drive:
        def changes(self): return Changes()

    class Client:
        outcomes = [
            BrainDeferred(429, "rate_limited", "30 reconciliations/min per key",
                          not_before="2099-01-01T00:00:00+00:00"),
            {"items": 2},
        ]
        revision = 0
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 6, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": [], "folderIds": [], "sharedDriveIds": ["drive-a", "drive-b"],
                "selectionState": "selected",
            })
        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": "account"}}
        def gdrive_token_provider(self, execution, grant):
            class Provider:
                def close(self): pass
            return Provider()
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, payload):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": payload}
        async def reconcile_gdrive(self, execution, **kwargs):
            deadlines.append(execution.run_deadline)
            outcome = type(self).outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        async def release_gdrive_execution(self, execution): pass

    class Source:
        def __init__(self, **kwargs): pass
        def set_run_deadline(self, deadline): pass
        def _services(self): return Drive(), object()
        def _execute(self, request): return request.execute()

    async def finished_stream(_settings, _conn, state, **kwargs):
        # The one deadline the provider reads use is the one the sink and reconcile calls carry.
        assert kwargs["execution"].run_deadline == kwargs["run_deadline"]
        namespace, generation = kwargs["namespace"], kwargs["generation"]
        if state.get_progress(namespace).active_snapshot is None:
            snapshot = state.begin_selection_snapshot(namespace, generation, [])
            state.publish_selection_snapshot(namespace, generation, snapshot)
        state.update_progress(
            namespace, listing_complete=True, page_token="terminal",
            checkpoint_id="terminal-page", terminal_drain_token="terminal",
            terminal_drain_checkpoint_id="terminal-page", terminal_drain_acknowledged=True,
            drain_observation=1, terminal_drain_observation=1,
        )
        return IngestSummary("docs", failure_categories={})

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", finished_stream)
    settings = BrainSettings("http://brain", "key", "team")
    connection = Connection("docs", "gdrive", options={"integration_id": integration_id})
    state = StateStore(str(tmp_path / "deferred-reconcile.sqlite"))
    started = time.monotonic()

    deferred = await run_gdrive_stream(settings, connection, state)

    # Every stream is complete, but absence was not established: nothing is reported current.
    assert deferred.authoritative_complete is False
    assert deferred.failed == 0 and deferred.failure_categories == {"rate_limited": 1}
    assert "current" not in {p.phase for p in state.list_progress(integration_id, 6)}
    # The reconciliation still owed is the backlog: zero would report nothing left to do.
    assert deferred.backlog is not None and deferred.backlog > 0

    completed = await run_gdrive_stream(settings, connection, state)

    assert completed.authoritative_complete is True and completed.removed == 2
    assert completed.backlog == 0
    assert {p.phase for p in state.list_progress(integration_id, 6)} == {"current"}
    assert len(deadlines) == 2
    assert all(started < deadline <= time.monotonic() + 55.0 for deadline in deadlines)
    state.close()


@pytest.mark.asyncio
async def test_staged_reconciliation_deferred_between_pages_reports_backlog_until_its_final_acknowledgment(
    tmp_path, monkeypatch,
):
    from aios_ingest.brain_client import BrainClient, _gdrive_members_digest
    from aios_ingest.scheduler import _gdrive_outcome_status

    integration_id = "00000000-0000-0000-0000-000000000035"
    members = ["doc-a", "doc-b", "doc-c"]
    # Two members to a request, so this selection is a staged snapshot of two pages.
    monkeypatch.setattr("aios_ingest.brain_client._GDRIVE_SNAPSHOT_PAGE", 2)
    requests, held, applied = [], [], []
    # The route's rate limit, as the number of requests admitted before every further one is 429.
    admitted = {"limit": 2}

    def brain(request):
        assert request.url.path == "/api/v1/items/source-reconcile"
        body = json.loads(request.content)
        requests.append(body)
        if admitted["limit"] is not None and len(requests) > admitted["limit"]:
            # Longer than any run has left: the upload is deferred, never slept on.
            return httpx.Response(429, headers={"retry-after": "120"}, json={
                "error": {"code": "rate_limited", "message": "30 reconciliations/min per key"},
            })
        snapshot = body["snapshot"]
        if snapshot.get("inspect"):
            return httpx.Response(200, json={"snapshotStaged": len(held)})
        if "resume" in snapshot:
            assert snapshot["resume"] == {"members": len(held), "digest": _gdrive_members_digest(held)}
        held.extend(snapshot["provider_ids"])
        if not snapshot["complete"]:
            return httpx.Response(200, json={"snapshotStaged": len(held)})
        assert len(set(held)) == snapshot["total"]
        applied.extend(sorted(held))
        return httpx.Response(200, json={"items": 4, "snapshotApplied": True})

    class Changes:
        def getStartPageToken(self, **kwargs):
            return _Request({"startPageToken": f"start:{kwargs.get('driveId')}"})

    class Drive:
        def changes(self): return Changes()

    class Client:
        revision = 0
        def __init__(self, *args, **kwargs):
            # The real client stages the snapshot; only the brain behind it is in memory.
            self.real = BrainClient("http://brain", "aios_abc_def", "team", max_per_min=10_000,
                                    random_fn=lambda: 0)
            self.real._client = httpx.AsyncClient(transport=httpx.MockTransport(brain))
        async def __aenter__(self): return self
        async def __aexit__(self, *args): await self.real._client.aclose()
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 6, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": [], "folderIds": [], "sharedDriveIds": ["drive-a"],
                "selectionState": "selected",
            })
        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": "account"}}
        def gdrive_token_provider(self, execution, grant):
            class Provider:
                def close(self): pass
            return Provider()
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, payload):
            type(self).revision += 1
            return {"progress_revision": type(self).revision, "progress": payload}
        async def reconcile_gdrive(self, execution, **kwargs):
            return await self.real.reconcile_gdrive(execution, **kwargs)
        async def release_gdrive_execution(self, execution): pass

    class Source:
        def __init__(self, **kwargs): pass
        def set_run_deadline(self, deadline): pass
        def _services(self): return Drive(), object()
        def _execute(self, request): return request.execute()

    async def finished_stream(_settings, _conn, state, **kwargs):
        namespace, generation = kwargs["namespace"], kwargs["generation"]
        if state.get_progress(namespace).active_snapshot is None:
            snapshot = state.begin_selection_snapshot(namespace, generation, [])
            for doc_id in members:
                state.record_membership(
                    namespace, generation, doc_id, "drive-a", "drive-a", snapshot_id=snapshot,
                )
            state.publish_selection_snapshot(namespace, generation, snapshot)
        state.update_progress(
            namespace, listing_complete=True, page_token="terminal",
            checkpoint_id="terminal-page", terminal_drain_token="terminal",
            terminal_drain_checkpoint_id="terminal-page", terminal_drain_acknowledged=True,
            drain_observation=1, terminal_drain_observation=1,
        )
        return IngestSummary("docs", failure_categories={})

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", finished_stream)
    settings = BrainSettings("http://brain", "key", "team")
    connection = Connection("docs", "gdrive", options={"integration_id": integration_id})
    state = StateStore(str(tmp_path / "staged-deferred-reconcile.sqlite"))

    # Run 1: the inspection and the first page are admitted; the completing page is not.
    first = await run_gdrive_stream(settings, connection, state)

    assert [body["snapshot"].get("complete") for body in requests] == [False, False, True]
    assert held == ["doc-a", "doc-b"] and applied == []
    assert first.authoritative_complete is False
    assert first.failed == 0 and first.failure_categories == {"rate_limited": 1}
    # Every stream is drained and nothing is queued locally, yet absence is not established: the
    # staged snapshot is the backlog, and the run is reported partial, never complete.
    assert state.pending_count(state.list_progress(integration_id, 6)[0].namespace, 6) == 0
    assert first.backlog is not None and first.backlog > 0
    assert _gdrive_outcome_status(first) == "partial"

    # Run 2: the brain still holds the prefix and the limit still bites on the completing page.
    admitted["limit"] = len(requests) + 1
    second = await run_gdrive_stream(settings, connection, state)

    assert applied == [] and second.authoritative_complete is False
    assert second.backlog is not None and second.backlog > 0
    assert "current" not in {p.phase for p in state.list_progress(integration_id, 6)}

    # Run 3: the completing page is acknowledged. Only now is the backlog zero.
    admitted["limit"] = None
    final = await run_gdrive_stream(settings, connection, state)

    assert applied == members
    assert final.authoritative_complete is True and final.removed == 4
    assert final.backlog == 0 and _gdrive_outcome_status(final) == "complete"
    assert {p.phase for p in state.list_progress(integration_id, 6)} == {"current"}
    state.close()


# ---------------------------------------------------------------------------------------------
# Selected file/folder roots bind to the stream of the drive that contains them
# ---------------------------------------------------------------------------------------------


def _binding_harness(monkeypatch, *, file_ids, folder_ids, shared_drive_ids, metadata):
    """Run the real coordinator entry point; ``metadata(root_id)`` plays Drive's files.get."""
    starts, reads, runs = [], [], []

    class Changes:
        def getStartPageToken(self, **kwargs):
            starts.append(kwargs.get("driveId", "my-drive"))
            return _Request({"startPageToken": f"start:{kwargs.get('driveId', 'my-drive')}"})

    class Drive:
        def changes(self): return Changes()

    class Client:
        revision = 0
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 5, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": file_ids, "folderIds": folder_ids, "sharedDriveIds": shared_drive_ids,
                "recursive": True, "selectionState": "selected",
            })
        async def broker_gdrive_access_token(self, execution):
            return {"access_token": "memory", "account": {"subject": "account"}}
        def gdrive_token_provider(self, execution, grant):
            class Provider:
                def close(self): pass
            return Provider()
        def gdrive_provider_gate(self, execution):
            class Gate:
                def __call__(self): pass
                def close(self): pass
            return Gate()
        async def checkpoint_gdrive_execution(self, execution, progress):
            self.revision += 1
            return {"progress_revision": self.revision, "progress": progress}
        async def release_gdrive_execution(self, execution): pass

    class Source:
        def __init__(self, **kwargs): pass
        def _services(self): return Drive(), object()
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id):
            reads.append(file_id)
            return metadata(file_id)

    async def capture(_settings, _conn, _state, **kwargs):
        runs.append((
            kwargs["drive_id"],
            _configured_roots(kwargs["options"], kwargs["drive_id"], kwargs["root_bindings"]),
        ))
        return IngestSummary("docs", failure_categories={})

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
    monkeypatch.setattr("aios_ingest.gdrive_sync._run_gdrive_stream_unlocked", capture)
    return starts, reads, runs


@pytest.mark.asyncio
async def test_selected_roots_bind_to_the_stream_of_the_drive_that_contains_them(tmp_path, monkeypatch):
    integration_id = "00000000-0000-0000-0000-000000000031"
    containing_drive = {"file-x": "shared-x", "folder-y": "shared-y", "folder-mine": None}

    def metadata(file_id):
        drive = containing_drive[file_id]
        return {"id": file_id, **({"driveId": drive} if drive else {})}

    starts, reads, runs = _binding_harness(
        monkeypatch, file_ids=["file-x"], folder_ids=["folder-y", "folder-mine"],
        shared_drive_ids=[], metadata=metadata,
    )
    settings = BrainSettings("http://brain", "key", "team")
    connection = Connection("docs", "gdrive", options={"integration_id": integration_id})
    path = tmp_path / "bound-roots.sqlite"
    state = StateStore(str(path))

    await run_gdrive_stream(settings, connection, state)

    assert reads == ["file-x", "folder-y", "folder-mine"]
    # Each containing drive gets its own start token, captured with that drive's id.
    assert starts == ["my-drive", "shared-x", "shared-y"]
    assert dict(runs) == {
        "my-drive": [("folder-mine", "folder", "my-drive", True)],
        "shared-x": [("file-x", "file", "shared-x", False)],
        "shared-y": [("folder-y", "folder", "shared-y", True)],
    }
    # Binding a root to a Shared Drive's stream selects that root, never the drive.
    assert all(kind != "drive" for roots in dict(runs).values() for _id, kind, _drive, _rec in roots)
    assert {
        progress.key.drive_id: progress.baseline_start_token
        for progress in state.list_progress(integration_id, 5)
    } == {"my-drive": "start:my-drive", "shared-x": "start:shared-x", "shared-y": "start:shared-y"}
    state.close()

    # A restart reads no root again and captures no second start token: the binding is durable.
    reads.clear(), starts.clear(), runs.clear()
    state = StateStore(str(path))
    await run_gdrive_stream(settings, connection, state)
    assert reads == [] and starts == []
    assert sorted(drive for drive, _roots in runs) == ["my-drive", "shared-x", "shared-y"]
    state.close()


@pytest.mark.asyncio
async def test_a_selection_wholly_inside_shared_drives_opens_no_my_drive_stream(tmp_path, monkeypatch):
    integration_id = "00000000-0000-0000-0000-000000000032"
    starts, _reads, runs = _binding_harness(
        monkeypatch, file_ids=["file-x"], folder_ids=["folder-x"], shared_drive_ids=["shared-x"],
        metadata=lambda file_id: {"id": file_id, "driveId": "shared-x"},
    )
    state = StateStore(str(tmp_path / "shared-only.sqlite"))

    await run_gdrive_stream(
        BrainSettings("http://brain", "key", "team"),
        Connection("docs", "gdrive", options={"integration_id": integration_id}), state,
    )

    assert starts == ["shared-x"]
    # The drive was ALSO selected whole: its root joins the roots bound to it, losing neither.
    assert runs == [("shared-x", [
        ("file-x", "file", "shared-x", False),
        ("folder-x", "folder", "shared-x", True),
        ("shared-x", "drive", "shared-x", True),
    ])]
    state.close()


@pytest.mark.asyncio
async def test_unreadable_selected_root_enumerates_nothing_and_binding_resumes_where_it_stopped(
    tmp_path, monkeypatch,
):
    integration_id = "00000000-0000-0000-0000-000000000033"
    available = {"file-a": {"id": "file-a", "driveId": "shared-x"}}

    def metadata(file_id):
        if file_id not in available:
            raise RuntimeError("404 file not found")
        return available[file_id]

    starts, reads, runs = _binding_harness(
        monkeypatch, file_ids=["file-a", "file-b"], folder_ids=[], shared_drive_ids=["shared-z"],
        metadata=metadata,
    )
    settings = BrainSettings("http://brain", "key", "team")
    connection = Connection("docs", "gdrive", options={"integration_id": integration_id})
    state = StateStore(str(tmp_path / "unreadable-root.sqlite"))

    blocked = await run_gdrive_stream(settings, connection, state)

    assert blocked.failed == 1 and blocked.failure_categories == {"selection_root_unresolved": 1}
    assert reads == ["file-a", "file-b"]
    # Where `file-b` lives is unknown, so the set of streams is unknown: none is started on a guess.
    assert starts == [] and runs == []
    assert state.list_progress(integration_id, 5) == []

    available["file-b"] = {"id": "file-b"}
    reads.clear()
    resumed = await run_gdrive_stream(settings, connection, state)

    assert resumed.failed == 0
    assert reads == ["file-b"]
    assert starts == ["my-drive", "shared-x", "shared-z"]
    assert dict(runs) == {
        "my-drive": [("file-b", "file", "my-drive", False)],
        "shared-x": [("file-a", "file", "shared-x", False)],
        "shared-z": [("shared-z", "drive", "shared-z", True)],
    }
    state.close()


@pytest.mark.parametrize("failure,category", [
    (ProviderDeferred("quota", not_before="2099-01-01T00:00:00+00:00", category="rate_limited"),
     "rate_limited"),
    (BrainError(409, "stale_execution", "replaced"), "stale_execution"),
])
@pytest.mark.asyncio
async def test_root_binding_interrupted_by_the_provider_or_authority_enumerates_nothing(
    tmp_path, monkeypatch, failure, category,
):
    integration_id = "00000000-0000-0000-0000-000000000034"

    def metadata(_file_id):
        raise failure

    starts, _reads, runs = _binding_harness(
        monkeypatch, file_ids=["file-a"], folder_ids=[], shared_drive_ids=[], metadata=metadata,
    )
    state = StateStore(str(tmp_path / "interrupted-binding.sqlite"))

    summary = await run_gdrive_stream(
        BrainSettings("http://brain", "key", "team"),
        Connection("docs", "gdrive", options={"integration_id": integration_id}), state,
    )

    assert summary.failure_categories == {category: 1}
    assert starts == [] and runs == []
    state.close()


@pytest.mark.asyncio
async def test_bound_shared_drive_stream_uses_that_drives_cursor_without_selecting_the_drive(tmp_path):
    state = StateStore(str(tmp_path / "bound-stream.sqlite"))
    key = StreamKey("team", "connection", "account", "shared-x")
    namespace = key.namespace(3)
    bindings = {
        ("file", "file-x"): "shared-x", ("folder", "folder-y"): "shared-x",
        ("folder", "folder-mine"): "my-drive",
    }
    docs = {
        doc_id: {
            "id": doc_id, "name": doc_id, "mimeType": _DOC_MIME, "driveId": "shared-x",
            "modifiedTime": "2026-09-22T00:00:00Z", "parents": [parent],
        }
        for doc_id, parent in (
            ("file-x", "elsewhere"), ("doc-in-y", "folder-y"), ("new-in-y", "folder-y"),
        )
    }
    unrelated = {
        doc_id: {**docs["file-x"], "id": doc_id, "name": doc_id, "parents": [parent]}
        for doc_id, parent in (("unrelated", "other-folder"), ("at-drive-root", "shared-x"))
    }

    class Files:
        calls = []
        def list(self, **kwargs):
            self.calls.append(kwargs)
            return _Request({"files": [docs["doc-in-y"]]})

    class Changes:
        starts, lists = [], []
        def getStartPageToken(self, **kwargs):
            self.starts.append(kwargs)
            return _Request({"startPageToken": "start:shared-x"})
        def list(self, **kwargs):
            self.lists.append(kwargs)
            # The drive's change log reports everything in the drive, selected or not.
            return _Request({
                "changes": [
                    {"fileId": doc_id, "file": meta}
                    for doc_id, meta in (
                        ("file-x", docs["file-x"]), ("new-in-y", docs["new-in-y"]),
                        ("unrelated", unrelated["unrelated"]),
                        ("at-drive-root", unrelated["at-drive-root"]),
                    )
                ],
                "newStartPageToken": "terminal",
            })

    class Drive:
        def __init__(self): self.file_api, self.change_api = Files(), Changes()
        def files(self): return self.file_api
        def changes(self): return self.change_api

    class Source:
        root_reads = []
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id):
            if file_id == "folder-y":
                # A bound folder root is read where it is now before it is listed.
                self.root_reads.append(file_id)
                return {"id": file_id, "mimeType": _FOLDER_MIME, "driveId": "shared-x"}
            assert file_id in docs, f"{file_id} is not selected and must never be read"
            return docs[file_id]
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], title=meta["name"], body="body")

    client, drive = _RecordingBrain(), Drive()
    summary = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=GdriveExecution("connection", 3, 1, "owner", "later", "scope", {}),
        options={
            "credential_identity": "account", "selection_state": "selected",
            "file_ids": ["file-x"], "folder_ids": ["folder-y", "folder-mine"], "recursive": True,
        }, source=Source(), drive=drive, generation=3, drive_id="shared-x",
        namespace=namespace, max_work=10, root_bindings=bindings,
    )

    assert summary.failed == 0
    # Only this stream's own folder root was read: never the My Drive folder bound elsewhere.
    assert Source.root_reads == ["folder-y"]
    # The stream's start token, its folder listing and its changes are all the Shared Drive's own.
    assert drive.change_api.starts == [{"supportsAllDrives": True, "driveId": "shared-x"}]
    (listing,) = drive.file_api.calls
    assert listing["corpora"] == "drive" and listing["driveId"] == "shared-x"
    assert listing["q"] == "'folder-y' in parents and trashed = false"
    assert [call["driveId"] for call in drive.change_api.lists] == ["shared-x"]
    assert drive.change_api.lists[0]["pageToken"] == "start:shared-x"
    # Only the two bound roots are roots here: not the drive, and not the My Drive folder.
    assert {(row["root_kind"], row["root_id"], row["drive_id"]) for row in state.list_roots(namespace, 3)} == {
        ("file", "file-x", "shared-x"), ("folder", "folder-y", "shared-x"),
    }
    # Baseline, then the drive's change page: the selected file's edit and the folder's new
    # document arrive; the drive's other documents are neither members nor ever pushed.
    assert client.pushed == ["file-x", "doc-in-y", "file-x", "new-in-y"]
    assert state.membership_ids(namespace, 3) == ["doc-in-y", "file-x", "new-in-y"]
    assert state.get_progress(namespace).page_token == "terminal"
    state.close()


@pytest.mark.asyncio
async def test_bound_file_found_in_another_drive_keeps_its_baseline_partial(tmp_path):
    state = StateStore(str(tmp_path / "relocated-root.sqlite"))
    key = StreamKey("team", "connection", "account", "shared-x")
    namespace = key.namespace(3)

    class Changes:
        lists = 0
        def getStartPageToken(self, **kwargs): return _Request({"startPageToken": "start"})
        def list(self, **kwargs):
            type(self).lists += 1
            return _Request({"changes": [], "newStartPageToken": "terminal"})

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id):
            # Bound to shared-x when the generation began; it has since been moved to shared-z,
            # whose changes this stream's cursor never reports.
            return {"id": file_id, "name": file_id, "mimeType": _DOC_MIME, "driveId": "shared-z",
                    "modifiedTime": "2026-09-22T00:00:00Z", "parents": ["shared-z"]}
        def _raw_doc(self, meta):
            raise AssertionError("a relocated root must not be ingested through the wrong stream")

    client = _RecordingBrain()
    summary = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=GdriveExecution("connection", 3, 1, "owner", "later", "scope", {}),
        options={"credential_identity": "account", "selection_state": "selected", "file_ids": ["file-x"]},
        source=Source(), drive=Drive(), generation=3, drive_id="shared-x",
        namespace=namespace, max_work=10, root_bindings={("file", "file-x"): "shared-x"},
    )

    progress = state.get_progress(namespace)
    assert summary.failed == 1 and client.pushed == []
    assert progress.listing_complete is False and progress.phase == "partial"
    assert progress.last_error == "baseline: SelectedRootRelocated"
    assert state.membership_ids(namespace, 3, building=True) == []
    # No change page is drained on top of an unproven baseline.
    assert Changes.lists == 0
    # Where it was read is durable: still bound to shared-x, on its way to shared-z's stream.
    relocating = state.unsettled_roots("connection", 3)
    assert {root: (b.drive_id, b.status, b.pending_drive_id) for root, b in relocating.items()} == {
        ("file", "file-x"): ("shared-x", "relocating", "shared-z"),
    }
    assert state.root_bindings("connection", 3) == {("file", "file-x"): "shared-x"}
    state.close()


@pytest.mark.asyncio
async def test_root_left_in_my_drive_state_from_before_binding_is_not_ingested_twice(tmp_path):
    state = StateStore(str(tmp_path / "pre-binding-roots.sqlite"))
    key = StreamKey("team", "connection", "account", "my-drive")
    namespace = key.namespace(3)
    # Local state written before roots were bound: both files are My Drive roots here.
    state.begin_generation(key, 3, start_token="start")
    state.replace_roots(namespace, 3, [
        ("file-x", "file", "my-drive", False), ("mine", "file", "my-drive", False),
    ])
    metadata = {
        "file-x": {"id": "file-x", "name": "X", "mimeType": _DOC_MIME, "driveId": "shared-x",
                   "modifiedTime": "2026-09-22T00:00:00Z", "parents": ["shared-x"]},
        "mine": {"id": "mine", "name": "Mine", "mimeType": _DOC_MIME,
                 "modifiedTime": "2026-09-22T00:00:00Z", "parents": ["root"]},
    }

    class Changes:
        def getStartPageToken(self, **kwargs):
            raise AssertionError("an existing stream keeps its captured start token")
        def list(self, **kwargs):
            return _Request({"changes": [], "newStartPageToken": "terminal"})

    class Drive:
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id): return metadata[file_id]
        def _raw_doc(self, meta):
            return RawDoc(source="gdrive", external_id=meta["id"], title=meta["name"], body="body")

    client = _RecordingBrain()
    summary = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=client, execution=GdriveExecution("connection", 3, 1, "owner", "later", "scope", {}),
        options={
            "credential_identity": "account", "selection_state": "selected",
            "file_ids": ["file-x", "mine"],
        }, source=Source(), drive=Drive(), generation=3, drive_id="my-drive",
        namespace=namespace, max_work=10,
        root_bindings={("file", "file-x"): "shared-x", ("file", "mine"): "my-drive"},
    )

    # `file-x` belongs to shared-x's stream now. This stream still finishes, without it.
    assert summary.failed == 0 and client.pushed == ["mine"]
    assert state.membership_ids(namespace, 3) == ["mine"]
    assert state.get_progress(namespace).listing_complete is True
    state.close()


# ---------------------------------------------------------------------------------------------
# A selected root that moves to another drive is still selected: nothing becomes absent
# ---------------------------------------------------------------------------------------------
#
# Spec. A selected file or folder is selected by its id, wherever it lives. Moved to another drive
# it is reported by the old drive's change log as removed — it and everything under it — and a
# listing of it in the old drive is empty. Neither is absence:
#   · its current metadata is read, under the run's own fence, before anything is concluded;
#   · read in another drive, its claims stand, the old stream goes on with its other roots, and
#     that drive's stream takes it over only after capturing its own start token — enumerating
#     that root and nothing else of the drive;
#   · unreadable, it is durably uncertain: no absence, and the connection is not complete;
#   · only once every stream has a verified snapshot of the roots it now holds may the
#     connection reconcile — and the moved documents are in that snapshot.

_WORLD_INTEGRATION = "00000000-0000-0000-0000-000000000041"


class _ProviderHttpError(Exception):
    """A provider failure as the Google client raises it: the HTTP status is on ``resp``."""

    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.resp = type("Response", (), {"status": status})()


class _Lazy:
    def __init__(self, run):
        self.run = run

    def execute(self):
        return self.run()


class _Closable:
    def __call__(self): pass
    def close(self): pass


class _DriveWorld:
    """Google Drive and the brain, as the real coordinator's own calls see them.

    A file lives in one drive, under its parents. Each drive has an append-only change log, and a
    change token is that drive's name and a position in its log. Every provider call is recorded
    in ``calls``, in order; the brain records what it is pushed, told to remove, and reconciled to.
    """

    def __init__(self, *, file_ids=(), folder_ids=(), generation=9,
                 integration_id=_WORLD_INTEGRATION):
        self.integration_id = integration_id
        self.config = {
            "authMode": "oauth", "authenticatedAccountId": "account",
            "fileIds": list(file_ids), "folderIds": list(folder_ids), "sharedDriveIds": [],
            "recursive": True, "selectionState": "selected",
        }
        self.generation = generation
        self.files, self.logs, self.calls = {}, {}, []
        self.unreadable, self.token_errors = {}, {}
        # A drive whose cursor is rejected; failures to raise, once each, from a drive's next
        # change reads; and something to run once, right after one recorded listing was taken.
        self.cursor_errors, self.change_errors, self.hooks = {}, {}, {}
        self.pushed, self.removed, self.reconciled = [], [], []
        self.progress, self.revision = {}, 0
        # Failures to raise, once each, from the next checkpoint written for a drive's stream —
        # the process dying there; and whether the brain acknowledges with its own copy of what
        # it stored, as a real HTTP round trip does, instead of the object it was handed.
        self.checkpoint_crashes, self.ack_copies = {}, False
        # Documents whose required content is missing; checkpoints to fail by what they say — each
        # a callable given the payload, returning the error to raise, once; and the brain's record
        # of which connection claims what, when more than one connection is modelled.
        self.malformed, self.checkpoint_faults, self.ledger = set(), [], None

    def put(self, file_id, *, drive, parent=None, folder=False):
        self.files[file_id] = {
            "id": file_id, "name": file_id, "mimeType": _FOLDER_MIME if folder else _DOC_MIME,
            "modifiedTime": "2026-09-22T00:00:00Z", "parents": [parent or drive],
            **({} if drive == "my-drive" else {"driveId": drive}),
        }

    def move(self, *file_ids, source, destination, parent=None):
        """Move files between Shared Drives: gone from one drive's log, present in the other's."""
        for file_id in file_ids:
            self.files[file_id]["driveId"] = destination
            if parent is not None:
                self.files[file_id]["parents"] = [parent]
            self.logs.setdefault(source, []).append({"fileId": file_id, "removed": True})
            self.logs.setdefault(destination, []).append(
                {"fileId": file_id, "file": dict(self.files[file_id])}
            )

    def namespace(self, drive_id):
        return StreamKey("team", self.integration_id, "account", drive_id).namespace(self.generation)

    def stream(self, drive_id):
        """One stream as the brain durably holds it."""
        return self.progress["streams"][drive_id]

    def install(self, monkeypatch):
        world = self

        class Changes:
            def getStartPageToken(self, **kwargs):
                drive_id = kwargs.get("driveId", "my-drive")

                def start():
                    world.calls.append(("start", drive_id))
                    if drive_id in world.token_errors:
                        raise world.token_errors[drive_id]
                    return {"startPageToken": f"{drive_id}@{len(world.logs.setdefault(drive_id, []))}"}
                return _Lazy(start)

            def list(self, **kwargs):
                drive_id = kwargs.get("driveId", "my-drive")

                def changes():
                    world.calls.append(("changes", drive_id, kwargs["pageToken"]))
                    if world.change_errors.get(drive_id):
                        raise world.change_errors[drive_id].pop(0)
                    if drive_id in world.cursor_errors:
                        raise world.cursor_errors[drive_id]
                    name, _, position = kwargs["pageToken"].rpartition("@")
                    assert name == drive_id, "a drive's token is only ever read against that drive"
                    log = world.logs.setdefault(drive_id, [])
                    return {"changes": log[int(position):], "newStartPageToken": f"{drive_id}@{len(log)}"}
                return _Lazy(changes)

        class Files:
            def list(self, **kwargs):
                folder_id = kwargs["q"].split("'")[1]
                drive_id = kwargs.get("driveId", "my-drive")

                def listing():
                    world.calls.append(("list", drive_id, folder_id))
                    found = {"files": [
                        dict(meta) for meta in world.files.values()
                        if folder_id in meta["parents"] and meta.get("driveId", "my-drive") == drive_id
                        and not meta.get("trashed")
                    ]}
                    world.hooks.pop(("list", drive_id, folder_id), lambda: None)()
                    return found
                return _Lazy(listing)

        class Drive:
            def changes(self): return Changes()
            def files(self): return Files()

        class Source:
            def __init__(self, **kwargs): pass
            def set_run_deadline(self, deadline): pass
            def _services(self): return Drive(), object()
            def _execute(self, request): return request.execute()

            def _metadata(self, file_id):
                world.calls.append(("metadata", file_id))
                if file_id in world.unreadable:
                    raise world.unreadable[file_id]
                if file_id not in world.files:
                    raise _ProviderHttpError(404)
                return dict(world.files[file_id])

            def _raw_doc(self, meta):
                world.calls.append(("doc", meta["id"]))
                if meta["id"] in world.malformed:
                    raise IncompleteExtractionError("required content is missing")
                return RawDoc(source="gdrive", external_id=meta["id"], title=meta["name"], body="body")

        class Client:
            def __init__(self, *args, **kwargs): pass
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass

            async def acquire_gdrive_execution(self, requested, owner):
                return GdriveExecution(
                    requested, world.generation, 1, owner, "later", "scope", dict(world.config),
                    progress=json.loads(json.dumps(world.progress)), progress_revision=world.revision,
                )

            async def broker_gdrive_access_token(self, execution):
                return {"access_token": "memory", "account": {"subject": "account"}}

            def gdrive_token_provider(self, execution, grant): return _Closable()
            def gdrive_provider_gate(self, execution): return _Closable()

            async def checkpoint_gdrive_execution(self, execution, progress):
                if world.checkpoint_crashes.get(progress.get("drive_id")):
                    raise world.checkpoint_crashes[progress["drive_id"]].pop(0)
                for fault in list(world.checkpoint_faults):
                    error = fault(progress)
                    if error is not None:
                        world.checkpoint_faults.remove(fault)
                        raise error
                world.revision += 1
                world.progress = json.loads(json.dumps(progress))
                acknowledged = json.loads(json.dumps(progress)) if world.ack_copies else progress
                return {"progress_revision": world.revision, "progress": acknowledged}

            async def push(self, payload, *, execution):
                world.pushed.append(payload.frontmatter["source_id"])
                if world.ledger is not None:
                    world.ledger.push(execution.integration_id, payload.frontmatter["source_id"])
                return IngestResult("created", "item", payload.path)

            async def reconcile_gdrive(self, execution, **kwargs):
                world.removed.extend(kwargs.get("removed_provider_ids") or [])
                if kwargs.get("complete_snapshot_ids") is not None:
                    world.reconciled.append(list(kwargs["complete_snapshot_ids"]))
                if world.ledger is not None:
                    world.ledger.reconcile(
                        execution.integration_id,
                        removed=kwargs.get("removed_provider_ids") or (),
                        complete=kwargs.get("complete_snapshot_ids"),
                    )
                return {"items": 0}

            async def release_gdrive_execution(self, execution): pass

        monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
        monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
        return self

    async def run(self, state):
        return await run_gdrive_stream(
            BrainSettings("http://brain", "key", "team"),
            Connection("docs", "gdrive", options={"integration_id": self.integration_id}), state,
        )


def _unsettled(state, generation=9):
    return {
        root: (binding.drive_id, binding.status, binding.pending_drive_id)
        for root, binding in state.unsettled_roots(_WORLD_INTEGRATION, generation).items()
    }


def _roots(state, world, drive_id):
    return {
        (row["root_kind"], row["root_id"], row["drive_id"])
        for row in state.list_roots(world.namespace(drive_id), world.generation)
    }


@pytest.mark.asyncio
async def test_selected_file_moved_to_another_shared_drive_after_baseline_keeps_its_claim_and_is_rebound(
    tmp_path, monkeypatch,
):
    world = _DriveWorld(file_ids=["file-x", "file-k"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("file-k", drive="shared-a")
    path = str(tmp_path / "file-relocation.sqlite")
    state = StateStore(path)

    baseline = await world.run(state)

    assert baseline.authoritative_complete is True
    assert world.pushed == ["file-k", "file-x"]
    assert world.reconciled == [["file-k", "file-x"]]

    # `file-x` is moved to shared-b. The old drive's change log reports it removed.
    world.move("file-x", source="shared-a", destination="shared-b")
    world.calls.clear()
    moved = await world.run(state)

    # Its own metadata was read before anything was concluded from that removal…
    assert ("metadata", "file-x") in world.calls
    # …so nothing was removed and nothing reconciled: the claim the old stream made stands, in its
    # authoritative snapshot and on the brain.
    assert world.removed == [] and world.reconciled == [["file-k", "file-x"]]
    assert state.membership_ids(world.namespace("shared-a"), 9) == ["file-k", "file-x"]
    assert _unsettled(state) == {("file", "file-x"): ("shared-a", "relocating", "shared-b")}
    assert moved.authoritative_complete is False
    assert moved.backlog is not None and moved.backlog > 0
    assert world.stream("shared-a")["phase"] != "current"
    # The destination is not a stream yet: not one call was made against it.
    assert not [call for call in world.calls if "shared-b" in call]
    state.close()

    # A restart. The destination's start token is captured before anything is enumerated there.
    state = StateStore(path)
    world.calls.clear()
    world.pushed.clear()
    rebound = await world.run(state)

    assert world.calls[0] == ("start", "shared-b")
    assert world.calls.index(("start", "shared-b")) < world.calls.index(("metadata", "file-x"))
    assert world.calls.count(("start", "shared-b")) == 1
    assert state.root_bindings(_WORLD_INTEGRATION, 9) == {
        ("file", "file-k"): "shared-a", ("file", "file-x"): "shared-b",
    }
    assert _unsettled(state) == {}
    # The destination enumerates the selected file and nothing else of its drive: no drive root,
    # no listing — and its cursor is the token captured before that enumeration.
    assert _roots(state, world, "shared-b") == {("file", "file-x", "shared-b")}
    assert not [call for call in world.calls if call[0] == "list"]
    assert state.get_progress(world.namespace("shared-b")).baseline_start_token == "shared-b@1"
    # The old stream went on with its other root, and no longer holds the one that left.
    assert _roots(state, world, "shared-a") == {("file", "file-k", "shared-a")}
    assert state.membership_ids(world.namespace("shared-a"), 9) == ["file-k"]
    assert state.membership_ids(world.namespace("shared-b"), 9) == ["file-x"]
    assert sorted(world.pushed) == ["file-k", "file-x"]
    # Only now — both snapshots verified — does the connection reconcile, and the moved file is
    # in what it reconciles to. It was never absent.
    assert rebound.authoritative_complete is True and rebound.backlog == 0
    assert world.reconciled == [["file-k", "file-x"], ["file-k", "file-x"]]
    assert world.removed == []
    assert {world.stream(drive)["phase"] for drive in ("shared-a", "shared-b")} == {"current"}
    state.close()


@pytest.mark.asyncio
async def test_selected_folder_moved_to_another_shared_drive_is_not_absent_by_removal_or_empty_listing(
    tmp_path, monkeypatch,
):
    world = _DriveWorld(folder_ids=["folder-r", "folder-k"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-r")
    world.put("folder-k", drive="shared-a", folder=True)
    world.put("doc-k", drive="shared-a", parent="folder-k")
    path = str(tmp_path / "folder-relocation.sqlite")
    state = StateStore(path)

    baseline = await world.run(state)

    assert baseline.authoritative_complete is True
    assert world.reconciled == [["doc-1", "doc-k"]]

    # The folder and its document move to shared-b. The old drive's log reports the document
    # removed BEFORE the folder itself — the order least favourable to the old stream.
    world.move("doc-1", "folder-r", source="shared-a", destination="shared-b")
    world.calls.clear()
    moved = await world.run(state)

    assert ("metadata", "folder-r") in world.calls
    # Neither the document's removal nor the folder's is absence…
    assert world.removed == [] and world.reconciled == [["doc-1", "doc-k"]]
    assert state.membership_ids(world.namespace("shared-a"), 9) == ["doc-1", "doc-k"]
    assert _unsettled(state) == {("folder", "folder-r"): ("shared-a", "relocating", "shared-b")}
    assert moved.authoritative_complete is False and moved.backlog > 0
    # …and the folder is never listed in the drive it left: that listing is empty, and proves nothing.
    assert ("list", "shared-a", "folder-r") not in world.calls
    state.close()

    state = StateStore(path)
    world.calls.clear()
    rebound = await world.run(state)

    assert world.calls[0] == ("start", "shared-b")
    assert world.calls.index(("start", "shared-b")) < world.calls.index(("list", "shared-b", "folder-r"))
    assert ("list", "shared-a", "folder-r") not in world.calls
    # Only the selected folder is enumerated in the destination: never the drive itself.
    assert [call for call in world.calls if call[0] == "list" and call[1] == "shared-b"] == [
        ("list", "shared-b", "folder-r"),
    ]
    assert _roots(state, world, "shared-b") == {("folder", "folder-r", "shared-b")}
    assert _roots(state, world, "shared-a") == {("folder", "folder-k", "shared-a")}
    assert state.membership_ids(world.namespace("shared-b"), 9) == ["doc-1"]
    assert state.membership_ids(world.namespace("shared-a"), 9) == ["doc-k"]
    assert _unsettled(state) == {}
    assert rebound.authoritative_complete is True and rebound.backlog == 0
    assert world.reconciled == [["doc-1", "doc-k"], ["doc-1", "doc-k"]]
    assert world.removed == []
    state.close()


@pytest.mark.asyncio
async def test_root_whose_location_cannot_be_read_is_durably_uncertain_and_never_absent(
    tmp_path, monkeypatch,
):
    world = _DriveWorld(file_ids=["file-x", "file-k"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("file-k", drive="shared-a")
    path = str(tmp_path / "uncertain-root.sqlite")
    state = StateStore(path)
    await world.run(state)
    cursor = state.get_progress(world.namespace("shared-a")).page_token

    # The old drive's log reports `file-x` removed, and where it is now cannot be read.
    world.logs["shared-a"].append({"fileId": "file-x", "removed": True})
    world.unreadable["file-x"] = _ProviderHttpError(403)

    for _run in range(2):
        world.calls.clear()
        unverified = await world.run(state)

        assert unverified.failure_categories == {"selection_root_unverified": 1}
        assert unverified.authoritative_complete is False and unverified.backlog > 0
        assert world.removed == [] and world.reconciled == [["file-k", "file-x"]]
        assert state.membership_ids(world.namespace("shared-a"), 9) == ["file-k", "file-x"]
        assert _unsettled(state) == {("file", "file-x"): ("shared-a", "uncertain", None)}
        # The cursor did not pass the page it could not interpret: it is read again next run.
        assert state.get_progress(world.namespace("shared-a")).page_token == cursor
        assert ("changes", "shared-a", cursor) in world.calls
        # The brain holds the stream as partial, with why.
        assert world.stream("shared-a")["phase"] == "partial"
        assert world.stream("shared-a")["last_error"] == "selected root file-x unverified; absence withheld"
        # The uncertainty survives a restart.
        state.close()
        state = StateStore(path)
        assert _unsettled(state) == {("file", "file-x"): ("shared-a", "uncertain", None)}

    # Readable again — and it really was deleted: the provider says there is no such file. Only
    # that makes the removal absence.
    del world.unreadable["file-x"]
    del world.files["file-x"]
    verified = await world.run(state)

    assert _unsettled(state) == {}
    assert world.removed == ["file-x"]
    assert verified.authoritative_complete is True and verified.backlog == 0
    assert world.reconciled == [["file-k", "file-x"], ["file-k"]]
    state.close()


@pytest.mark.asyncio
async def test_bound_folder_found_in_another_drive_on_baseline_is_relocating_and_never_listed_empty(tmp_path):
    state = StateStore(str(tmp_path / "relocated-folder-baseline.sqlite"))
    key = StreamKey("team", "connection", "account", "shared-x")
    namespace = key.namespace(3)
    lists, change_reads = [], []

    class Files:
        def list(self, **kwargs):
            # What Drive answers for a folder that is no longer in this drive: nothing.
            lists.append(kwargs["q"])
            return _Request({"files": []})

    class Changes:
        def getStartPageToken(self, **kwargs): return _Request({"startPageToken": "start"})
        def list(self, **kwargs):
            change_reads.append(kwargs["pageToken"])
            return _Request({"changes": [], "newStartPageToken": "terminal"})

    class Drive:
        def files(self): return Files()
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id):
            return {"id": file_id, "mimeType": _FOLDER_MIME, "driveId": "shared-z"}

    client = _RecordingBrain()

    async def run():
        return await _run_gdrive_stream_unlocked(
            BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
            client=client, execution=GdriveExecution("connection", 3, 1, "owner", "later", "scope", {}),
            options={
                "credential_identity": "account", "selection_state": "selected",
                "folder_ids": ["folder-y"], "recursive": True,
            }, source=Source(), drive=Drive(), generation=3, drive_id="shared-x",
            namespace=namespace, max_work=10, root_bindings={("folder", "folder-y"): "shared-x"},
        )

    summary = await run()

    progress = state.get_progress(namespace)
    assert summary.failed == 1
    assert progress.listing_complete is False and progress.phase == "partial"
    assert progress.last_error == "baseline: SelectedRootRelocated"
    assert progress.active_snapshot is None
    # The empty listing was never asked for, so it was never mistaken for an empty folder; and no
    # change page is drained on top of an unproven baseline.
    assert lists == [] and change_reads == []
    assert {root: (b.drive_id, b.status, b.pending_drive_id)
            for root, b in state.unsettled_roots("connection", 3).items()} == {
        ("folder", "folder-y"): ("shared-x", "relocating", "shared-z"),
    }

    # While it is on its way to shared-z's stream this one still does not list it.
    await run()
    assert lists == []
    assert state.membership_ids(namespace, 3) == []
    assert ("folder", "folder-y") in state.unsettled_roots("connection", 3)
    state.close()


@pytest.mark.asyncio
async def test_bound_folder_whose_metadata_is_unreadable_keeps_its_baseline_partial_and_uncertain(tmp_path):
    state = StateStore(str(tmp_path / "unverified-folder-baseline.sqlite"))
    key = StreamKey("team", "connection", "account", "shared-x")
    namespace = key.namespace(3)
    lists = []

    class Files:
        def list(self, **kwargs):
            lists.append(kwargs["q"])
            return _Request({"files": []})

    class Changes:
        def getStartPageToken(self, **kwargs): return _Request({"startPageToken": "start"})
        def list(self, **kwargs): raise AssertionError("no change page on an unproven baseline")

    class Drive:
        def files(self): return Files()
        def changes(self): return Changes()

    class Source:
        def _execute(self, request): return request.execute()
        def _metadata(self, file_id): raise _ProviderHttpError(403)

    summary = await _run_gdrive_stream_unlocked(
        BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
        client=_RecordingBrain(),
        execution=GdriveExecution("connection", 3, 1, "owner", "later", "scope", {}),
        options={
            "credential_identity": "account", "selection_state": "selected",
            "folder_ids": ["folder-y"], "recursive": True,
        }, source=Source(), drive=Drive(), generation=3, drive_id="shared-x",
        namespace=namespace, max_work=10, root_bindings={("folder", "folder-y"): "shared-x"},
    )

    progress = state.get_progress(namespace)
    assert summary.failed == 1
    assert progress.listing_complete is False and progress.phase == "partial"
    assert progress.last_error == "baseline: SelectedRootUnverified"
    assert lists == [] and progress.active_snapshot is None
    (binding,) = state.unsettled_roots("connection", 3).values()
    assert (binding.drive_id, binding.status, binding.pending_drive_id) == ("shared-x", "uncertain", None)
    assert binding.detail == "root metadata unreadable (403)"
    state.close()


# ---------------------------------------------------------------------------------------------
# A drive whose change log cannot be opened is that stream's failure, not the connection's
# ---------------------------------------------------------------------------------------------
#
# Spec. A selected root can live in a Shared Drive whose change log the account cannot open (it
# was shared the file, not the drive): the start token request answers 403 or 404. That stream is
# recorded durably as not complete, with why; every stream that can be read still runs; nothing of
# the unreadable drive is enumerated on a guess; and the connection never reconciles without it.
# A failure of the connection's own authority still ends the whole run.


@pytest.mark.parametrize("status", [403, 404])
@pytest.mark.asyncio
async def test_unopenable_containing_drive_is_a_durable_stream_diagnostic_and_other_streams_progress(
    tmp_path, monkeypatch, status,
):
    world = _DriveWorld(file_ids=["file-x", "file-m"]).install(monkeypatch)
    world.put("file-x", drive="shared-x")
    world.put("file-m", drive="my-drive")
    world.token_errors["shared-x"] = _ProviderHttpError(status)
    path = str(tmp_path / f"unopenable-drive-{status}.sqlite")
    state = StateStore(path)
    diagnostic = f"start token unavailable: drive shared-x not found or not accessible ({status})"

    for _run in range(2):
        world.calls.clear()
        blocked = await world.run(state)

        # The readable stream ran to the end of its own work…
        assert world.pushed == ["file-m"]
        assert world.stream("my-drive")["listing_complete"] is True
        assert world.stream("my-drive")["last_error"] == "stream complete; awaiting all-stream reconciliation"
        # …the unreadable one is recorded, locally and on the brain, as not complete and why…
        assert blocked.failed == 1 and blocked.failure_categories == {"stream_start_unavailable": 1}
        local = state.get_progress(world.namespace("shared-x"))
        assert (local.phase, local.listing_complete, local.baseline_start_token) == ("partial", False, None)
        assert local.last_error == diagnostic
        assert world.stream("shared-x")["phase"] == "partial"
        assert world.stream("shared-x")["last_error"] == diagnostic
        assert world.stream("shared-x")["baseline_start_token"] is None
        # …nothing of its drive was enumerated without a token…
        assert ("start", "shared-x") in world.calls
        assert not [call for call in world.calls if call[0] in {"changes", "list"} and call[1] == "shared-x"]
        assert ("doc", "file-x") not in world.calls
        # …and the connection is neither complete nor reconciled, and says work remains.
        assert blocked.authoritative_complete is False
        assert blocked.backlog is not None and blocked.backlog > 0
        assert world.reconciled == [] and world.removed == []
        assert "current" not in {world.stream(drive)["phase"] for drive in ("my-drive", "shared-x")}
        state.close()
        state = StateStore(path)

    # The drive becomes readable: its token is captured before its root is enumerated, and only
    # then is the connection complete — with both documents.
    del world.token_errors["shared-x"]
    world.calls.clear()
    opened = await world.run(state)

    assert world.calls.index(("start", "shared-x")) < world.calls.index(("doc", "file-x"))
    assert state.get_progress(world.namespace("shared-x")).baseline_start_token == "shared-x@0"
    assert opened.failed == 0 and opened.authoritative_complete is True and opened.backlog == 0
    assert world.pushed == ["file-m", "file-x"]
    assert world.reconciled == [["file-m", "file-x"]]
    assert {world.stream(drive)["phase"] for drive in ("my-drive", "shared-x")} == {"current"}
    state.close()


@pytest.mark.asyncio
async def test_authority_failure_while_opening_a_stream_still_ends_the_whole_run(tmp_path, monkeypatch):
    world = _DriveWorld(file_ids=["file-x", "file-m"]).install(monkeypatch)
    world.put("file-x", drive="shared-x")
    world.put("file-m", drive="my-drive")
    # The execution was replaced: not this stream's problem, the connection's.
    world.token_errors["shared-x"] = BrainError(409, "stale_execution", "replaced")
    state = StateStore(str(tmp_path / "stale-while-opening.sqlite"))

    summary = await world.run(state)

    assert summary.failed == 1 and summary.failure_categories == {"stale_execution": 1}
    # No stream ran — not even the readable one — and no diagnostic stream was invented.
    assert world.pushed == [] and world.reconciled == []
    assert state.get_progress(world.namespace("shared-x")) is None
    assert not [call for call in world.calls if call[0] in {"changes", "list", "doc"}]
    state.close()


# ---------------------------------------------------------------------------------------------
# Notification hints are one bounded, race-safe dirty mark per stream
# ---------------------------------------------------------------------------------------------


def _notify(channel_id="chan-1", resource_id="res-1", token="secret", number="1"):
    from aios_ingest.webhook_app import _gdrive_notification

    return _gdrive_notification({
        "x-goog-channel-id": channel_id, "x-goog-resource-id": resource_id,
        "x-goog-channel-token": token, "x-goog-message-number": number,
        "x-goog-resource-state": "change",
    })


def test_any_number_of_notifications_is_one_dirty_mark_and_no_backlog(tmp_path, monkeypatch):
    path = tmp_path / "hints.sqlite"
    monkeypatch.setenv("AIOS_INGEST_STATE", str(path))
    key = StreamKey("team", "connection", "account", "shared-x")
    state = StateStore(str(path))
    progress = state.begin_generation(key, 3, start_token="start")
    state.save_channel(Channel(
        "docs", "chan-1", "res-1", "2099-01-01T00:00:00Z", progress.namespace,
        verification_hash("secret"),
    ))
    state.close()

    for number in range(200):
        assert _notify(number=str(number)).status_code == 202

    state = StateStore(str(path))
    # Not one work row: a flood can neither fill the document backlog nor spend a work budget.
    assert state.pending_count(progress.namespace, 3) == 0
    assert state._db.execute("select count(*) from pending_work").fetchone()[0] == 0
    assert state._db.execute("select count(*), max(dirty_seq) from stream_hints").fetchone()[:] == (1, 200)
    assert state.pending_stream_hint(key) == 200
    state.close()


def test_invalid_notification_marks_nothing(tmp_path, monkeypatch):
    path = tmp_path / "hints-invalid.sqlite"
    monkeypatch.setenv("AIOS_INGEST_STATE", str(path))
    key = StreamKey("team", "connection", "account", "shared-x")
    state = StateStore(str(path))
    progress = state.begin_generation(key, 3, start_token="start")
    state.save_channel(Channel(
        "docs", "chan-1", "res-1", "2099-01-01T00:00:00Z", progress.namespace,
        verification_hash("secret"),
    ))
    state.close()

    assert _notify(token="guessed").status_code == 401
    assert _notify(resource_id="other-resource").status_code == 401
    assert _notify(channel_id="unknown-channel").status_code == 401

    state = StateStore(str(path))
    assert state.pending_stream_hint(key) is None
    assert state._db.execute("select count(*) from stream_hints").fetchone()[0] == 0
    state.close()


def test_notification_on_a_channel_from_an_earlier_generation_marks_the_stream_the_coordinator_reads(
    tmp_path, monkeypatch,
):
    path = tmp_path / "hints-generations.sqlite"
    monkeypatch.setenv("AIOS_INGEST_STATE", str(path))
    key = StreamKey("team", "connection", "account", "shared-x")
    state = StateStore(str(path))
    earlier = state.begin_generation(key, 2, start_token="old-start")
    current = state.begin_generation(key, 3, start_token="new-start")
    assert earlier.namespace != current.namespace
    # The watch channel still names the namespace of the generation it was created under.
    state.save_channel(Channel(
        "docs", "chan-1", "res-1", "2099-01-01T00:00:00Z", earlier.namespace,
        verification_hash("secret"),
    ))
    state.close()

    assert _notify().status_code == 202

    state = StateStore(str(path))
    # The hint is on the stream itself, so the run for the CURRENT generation consumes it; it is
    # not stranded as work in a namespace nothing drains any more.
    assert state.pending_stream_hint(current.key) == 1
    assert state.pending_count(earlier.namespace, 2) == 0
    assert state.pending_count(current.namespace, 3) == 0
    state.close()


def test_hint_acknowledgment_covers_only_what_the_drain_observed_before_it_began(tmp_path):
    path = tmp_path / "hint-ack.sqlite"
    key = StreamKey("team", "connection", "account", "shared-x")
    other = StreamKey("team", "connection", "account", "shared-y")
    state = StateStore(str(path))
    assert state.pending_stream_hint(key) is None
    assert [state.record_stream_hint(key) for _ in range(3)] == [1, 2, 3]

    observed = state.pending_stream_hint(key)
    assert observed == 3
    # A notification lands while the drain that observed 3 is still reading.
    assert state.record_stream_hint(key) == 4
    state.ack_stream_hint(key, observed)
    assert state.pending_stream_hint(key) == 4

    # A late acknowledgment of an older observation cannot regress, and one for a sequence that
    # was never issued cannot clear the stream.
    state.ack_stream_hint(key, 2)
    state.ack_stream_hint(key, 99)
    assert state.pending_stream_hint(key) == 4
    assert state.pending_stream_hint(other) is None
    state.close()

    restarted = StateStore(str(path))
    assert restarted.pending_stream_hint(key) == 4
    restarted.ack_stream_hint(key, 4)
    assert restarted.pending_stream_hint(key) is None
    restarted.close()


@pytest.mark.asyncio
async def test_drain_acknowledges_the_hint_it_observed_and_keeps_one_that_arrives_mid_drain(tmp_path):
    state = StateStore(str(tmp_path / "hint-drain.sqlite"))
    key = StreamKey("team", "connection", "account", "my-drive")
    namespace = key.namespace(7)
    state.begin_generation(key, 7, start_token="baseline-start")
    snapshot = state.begin_selection_snapshot(namespace, 7, [])
    state.publish_selection_snapshot(namespace, 7, snapshot)
    state.update_progress(namespace, phase="partial", page_token="cursor", listing_complete=True)
    state.record_stream_hint(key)
    pages = [
        # Not terminal: more changes remain, so nothing may be acknowledged yet.
        {"changes": [], "nextPageToken": "next"},
        {"changes": [], "newStartPageToken": "terminal-1"},
        {"changes": [], "newStartPageToken": "terminal-2"},
    ]
    arrive_during_read = {2}

    class Changes:
        tokens = []
        def list(self, **kwargs):
            self.tokens.append(kwargs["pageToken"])
            if len(self.tokens) in arrive_during_read:
                # Google notifies again while this very page is being read.
                state.record_stream_hint(key)
            return _Request(pages.pop(0))

    class Drive:
        def __init__(self): self.api = Changes()
        def changes(self): return self.api

    class Source:
        def _execute(self, request): return request.execute()

    client, drive = _RecordingBrain(), Drive()

    async def run_once():
        return await _run_gdrive_stream_unlocked(
            BrainSettings("http://brain", "key", "team"), Connection("docs", "gdrive"), state,
            client=client,
            execution=GdriveExecution(
                "connection", 7, 1, "owner", "later", "scope", {},
                progress={}, progress_revision=client.revision,
            ),
            options={"credential_identity": "account", "selection_state": "selected"},
            source=Source(), drive=drive, generation=7, drive_id="my-drive",
            namespace=namespace, max_work=10, discovery_budget=1,
        )

    # Run 1 stops at its page budget before the terminal token: the hint stays pending.
    await run_once()
    assert drive.api.tokens == ["cursor"]
    assert state.pending_stream_hint(key) == 1

    # Run 2 reaches the terminal token, so the hint it observed (1) is acknowledged — but the one
    # that arrived while it was reading (2) is not: that change may be after what it read.
    await run_once()
    assert drive.api.tokens == ["cursor", "next"]
    assert state.pending_stream_hint(key) == 2

    # Run 3 begins after that notification and drains to the terminal token: now it is clean.
    await run_once()
    assert drive.api.tokens == ["cursor", "next", "terminal-1"]
    assert state.pending_stream_hint(key) is None
    state.close()


# ---------------------------------------------------------------------------------------------
# A start token a drive will not issue is that stream's failure, wherever it is asked for
# ---------------------------------------------------------------------------------------------
#
# Spec. A stream asks its drive for a start token when it begins, when its local state has to be
# recovered, and when its cursor is rejected. A Shared Drive that answers 403 or 404 at any of
# them is that stream's failure: it is recorded durably with why, it is backlog, everything the
# stream holds stays as it is (its cursor, its membership, the claims made through it), the
# connection does not reconcile without it, and every other stream still runs.


def _start_diagnostic(drive_id, status):
    return f"start token unavailable: drive {drive_id} not found or not accessible ({status})"


async def _world_with_one_shared_and_one_my_drive_file(tmp_path, monkeypatch, name):
    world = _DriveWorld(file_ids=["file-x", "file-m"]).install(monkeypatch)
    world.put("file-x", drive="shared-x")
    world.put("file-m", drive="my-drive")
    path = str(tmp_path / name)
    state = StateStore(path)
    baseline = await world.run(state)
    assert baseline.authoritative_complete is True
    assert world.reconciled == [["file-m", "file-x"]]
    return world, path, state


def _assert_shared_x_waits_on_its_start_token(world, state, summary, status, cursor, snapshot):
    """One run in which shared-x could not capture the token its recovery begins with."""
    namespace = world.namespace("shared-x")
    diagnostic = _start_diagnostic("shared-x", status)
    assert summary.failed == 1 and summary.failure_categories == {"stream_start_unavailable": 1}
    local = state.get_progress(namespace)
    # Recorded, locally and on the brain, as a recovery it still owes — and why.
    assert (local.phase, local.recovery_required, local.last_error) == ("partial", True, diagnostic)
    assert world.stream("shared-x")["phase"] == "partial"
    assert world.stream("shared-x")["recovery_required"] is True
    assert world.stream("shared-x")["last_error"] == diagnostic
    # Nothing it held was given up: its cursor, its published snapshot, its membership.
    assert local.page_token == cursor and local.baseline_start_token == "shared-x@0"
    assert local.active_snapshot == snapshot and local.building_snapshot is None
    assert state.membership_ids(namespace, 9) == ["file-x"]
    # No claim was removed and the connection did not reconcile without this stream…
    assert world.removed == [] and world.reconciled == [["file-m", "file-x"]]
    assert summary.authoritative_complete is False
    assert summary.backlog is not None and summary.backlog > 0
    # …while the stream that can be read ran to the end of its own work.
    assert world.stream("my-drive")["listing_complete"] is True
    assert world.stream("my-drive")["last_error"] == "stream complete; awaiting all-stream reconciliation"
    assert "current" not in {world.stream(drive)["phase"] for drive in ("my-drive", "shared-x")}


@pytest.mark.parametrize("status", [403, 404])
@pytest.mark.asyncio
async def test_start_token_refused_during_local_state_recovery_is_a_stream_diagnostic_that_keeps_claims(
    tmp_path, monkeypatch, status,
):
    world, path, state = await _world_with_one_shared_and_one_my_drive_file(
        tmp_path, monkeypatch, f"recovery-start-{status}.sqlite",
    )
    namespace = world.namespace("shared-x")
    cursor = state.get_progress(namespace).page_token
    snapshot = state.get_progress(namespace).active_snapshot

    # The brain's checkpoint for shared-x names a page this sidecar never retired: its local state
    # is not what the brain acknowledged, so the stream owes a controlled recovery — and the drive
    # refuses the start token that recovery begins with.
    world.progress["streams"]["shared-x"]["checkpoint_id"] = "page-this-sidecar-never-retired"
    world.revision += 1
    world.token_errors["shared-x"] = _ProviderHttpError(status)

    for _run in range(2):
        world.calls.clear()
        blocked = await world.run(state)

        _assert_shared_x_waits_on_its_start_token(world, state, blocked, status, cursor, snapshot)
        # The token is asked for again on every run, and nothing of the drive is read without it.
        assert ("start", "shared-x") in world.calls
        assert not [call for call in world.calls if call[0] in {"changes", "list"} and call[1] == "shared-x"]
        assert ("doc", "file-x") not in world.calls
        state.close()
        state = StateStore(path)

    # The drive issues a token again: captured before anything is enumerated, the recovery runs,
    # and only then does the connection reconcile — to both documents.
    del world.token_errors["shared-x"]
    world.calls.clear()
    recovered = await world.run(state)

    assert world.calls.index(("start", "shared-x")) < world.calls.index(("doc", "file-x"))
    assert recovered.failed == 0 and recovered.authoritative_complete is True and recovered.backlog == 0
    assert state.get_progress(namespace).recovery_required is False
    assert world.reconciled == [["file-m", "file-x"], ["file-m", "file-x"]]
    assert world.removed == []
    assert {world.stream(drive)["phase"] for drive in ("my-drive", "shared-x")} == {"current"}
    state.close()


@pytest.mark.parametrize("status", [403, 404])
@pytest.mark.asyncio
async def test_start_token_refused_after_an_invalid_cursor_keeps_the_cursor_and_claims_until_it_is_captured(
    tmp_path, monkeypatch, status,
):
    world, path, state = await _world_with_one_shared_and_one_my_drive_file(
        tmp_path, monkeypatch, f"invalid-cursor-start-{status}.sqlite",
    )
    namespace = world.namespace("shared-x")
    cursor = state.get_progress(namespace).page_token
    snapshot = state.get_progress(namespace).active_snapshot

    # Drive rejects the stream's cursor (410) and then refuses the start token to rescan from.
    world.cursor_errors["shared-x"] = ProviderCursorInvalid("expired")
    world.token_errors["shared-x"] = _ProviderHttpError(status)
    world.calls.clear()
    invalid = await world.run(state)

    assert world.calls.index(("changes", "shared-x", cursor)) < world.calls.index(("start", "shared-x"))
    _assert_shared_x_waits_on_its_start_token(world, state, invalid, status, cursor, snapshot)
    state.close()

    # A restart: the recovery it owes is retried from the top of the run. The cursor that was
    # rejected is not read again, and still nothing is concluded from it.
    state = StateStore(path)
    world.calls.clear()
    still = await world.run(state)

    assert ("start", "shared-x") in world.calls
    assert not [call for call in world.calls if call[0] in {"changes", "list"} and call[1] == "shared-x"]
    _assert_shared_x_waits_on_its_start_token(world, state, still, status, cursor, snapshot)

    # A token is issued: the controlled rescan runs from it, and the connection is complete.
    del world.token_errors["shared-x"]
    world.cursor_errors.clear()
    world.calls.clear()
    recovered = await world.run(state)

    assert world.calls.index(("start", "shared-x")) < world.calls.index(("doc", "file-x"))
    assert ("changes", "shared-x", cursor) in world.calls
    assert recovered.failed == 0 and recovered.authoritative_complete is True and recovered.backlog == 0
    assert state.membership_ids(namespace, 9) == ["file-x"]
    assert world.reconciled == [["file-m", "file-x"], ["file-m", "file-x"]]
    assert world.removed == []
    assert {world.stream(drive)["phase"] for drive in ("my-drive", "shared-x")} == {"current"}
    state.close()


# ---------------------------------------------------------------------------------------------
# A deferred empty-selection reconciliation is outstanding work until it is acknowledged
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("refusal,failed", [
    (BrainDeferred(429, "rate_limited", "30 reconciliations/min per key",
                   not_before="2099-01-01T00:00:00+00:00"), 0),
    (BrainError(503, "cleanup_unavailable", "retry"), 1),
])
@pytest.mark.asyncio
async def test_unacknowledged_empty_selection_reconciliation_is_backlog_and_partial_until_acknowledged(
    tmp_path, monkeypatch, refusal, failed,
):
    from aios_ingest.scheduler import _gdrive_outcome_status

    integration_id = "00000000-0000-0000-0000-000000000051"
    outcomes = [refusal, {"items": 3}]
    reconciled = []

    class Client:
        revision = 0
        def __init__(self, *args, **kwargs): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
        async def acquire_gdrive_execution(self, requested, owner):
            return GdriveExecution(requested, 4, 1, owner, "later", "scope", {
                "authMode": "oauth", "authenticatedAccountId": "account",
                "fileIds": [], "folderIds": [], "sharedDriveIds": [], "selectionState": "empty",
            })
        async def checkpoint_gdrive_execution(self, execution, payload):
            type(self).revision += 1
            return {"progress_revision": type(self).revision, "progress": payload}
        async def reconcile_gdrive(self, execution, **kwargs):
            reconciled.append(kwargs)
            outcome = outcomes.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        async def release_gdrive_execution(self, execution): pass

    monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
    settings = BrainSettings("http://brain", "key", "team")
    connection = Connection("docs", "gdrive", options={"integration_id": integration_id})
    path = str(tmp_path / "empty-selection-deferred.sqlite")
    state = StateStore(path)

    unacknowledged = await run_gdrive_stream(settings, connection, state)

    # The empty selection is published, but nothing was removed by it yet: that reconciliation is
    # the outstanding work. It is neither unmeasured (reported as a failed run) nor zero (done).
    assert unacknowledged.authoritative_complete is False
    assert unacknowledged.failed == failed
    assert unacknowledged.failure_categories == {refusal.code: 1}
    assert unacknowledged.backlog is not None and unacknowledged.backlog > 0
    assert _gdrive_outcome_status(unacknowledged) == "partial"
    assert {p.phase for p in state.list_progress(integration_id, 4)} == {"partial"}
    state.close()

    # A restart, and the reconciliation is acknowledged. Only now is the backlog zero.
    state = StateStore(path)
    acknowledged = await run_gdrive_stream(settings, connection, state)

    assert acknowledged.authoritative_complete is True and acknowledged.removed == 3
    assert acknowledged.failed == 0 and acknowledged.backlog == 0
    assert _gdrive_outcome_status(acknowledged) == "complete"
    assert {p.phase for p in state.list_progress(integration_id, 4)} == {"current"}
    assert [call["complete_snapshot_ids"] for call in reconciled] == [[], []]
    state.close()


# ---------------------------------------------------------------------------------------------
# A relocating root whose destination cannot be opened is read again on every run
# ---------------------------------------------------------------------------------------------
#
# Spec. A root read in another drive is handed to that drive's stream only once that stream holds
# a start token. While the drive refuses one, where the root is NOW is read again on each run: it
# may have been moved on to a third drive, or back. Until a hand-over it stays bound where it
# was, the claims made through it stand, and the connection is not complete.


async def _relocation_stalled_on_an_unopenable_destination(tmp_path, monkeypatch, name):
    """`file-x` left shared-a for shared-b, whose change log cannot be opened."""
    world = _DriveWorld(file_ids=["file-x", "file-k"]).install(monkeypatch)
    world.put("file-x", drive="shared-a")
    world.put("file-k", drive="shared-a")
    path = str(tmp_path / name)
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    assert world.reconciled == [["file-k", "file-x"]]

    world.move("file-x", source="shared-a", destination="shared-b")
    world.token_errors["shared-b"] = _ProviderHttpError(403)
    await world.run(state)
    assert _unsettled(state) == {("file", "file-x"): ("shared-a", "relocating", "shared-b")}

    for run in range(2):
        world.calls.clear()
        stalled = await world.run(state)

        # The destination is a stream that exists only as its diagnostic…
        assert stalled.failure_categories == {"stream_start_unavailable": 1}
        destination = state.get_progress(world.namespace("shared-b"))
        assert (destination.phase, destination.baseline_start_token) == ("partial", None)
        assert destination.last_error == _start_diagnostic("shared-b", 403)
        assert not [call for call in world.calls if call[0] in {"changes", "list"} and call[1] == "shared-b"]
        # …so the root is not handed over: it stays bound where it was, on its way there…
        assert _unsettled(state) == {("file", "file-x"): ("shared-a", "relocating", "shared-b")}
        assert state.root_bindings(_WORLD_INTEGRATION, 9) == {
            ("file", "file-k"): "shared-a", ("file", "file-x"): "shared-a",
        }
        # …its claim stands, and the connection is neither reconciled nor complete.
        assert world.removed == [] and world.reconciled == [["file-k", "file-x"]]
        assert stalled.authoritative_complete is False
        assert stalled.backlog is not None and stalled.backlog > 0
        if run:
            # Once its destination is known to be unopenable, where the root is now is read
            # again before that drive is asked for a token.
            assert world.calls.index(("metadata", "file-x")) < world.calls.index(("start", "shared-b"))
        state.close()
        state = StateStore(path)
    return world, path, state


@pytest.mark.asyncio
async def test_relocating_root_moved_on_to_a_third_drive_is_re_observed_and_handed_to_that_drive(
    tmp_path, monkeypatch,
):
    world, _path, state = await _relocation_stalled_on_an_unopenable_destination(
        tmp_path, monkeypatch, "relocation-b-to-c.sqlite",
    )

    # B→C: the root is moved on, to a drive whose change log can be opened.
    world.move("file-x", source="shared-b", destination="shared-c")
    world.calls.clear()
    world.pushed.clear()
    onward = await world.run(state)

    # It was read where it is now before any stream was opened…
    assert world.calls[0] == ("metadata", "file-x")
    # …the drive it only passed through is not a stream any more, locally or on the brain…
    assert ("start", "shared-b") not in world.calls
    assert state.get_progress(world.namespace("shared-b")) is None
    assert "shared-b" not in world.progress["streams"]
    # …and the drive it is in took it over, with a token captured before it was enumerated.
    assert world.calls.index(("start", "shared-c")) < world.calls.index(("doc", "file-x"))
    assert state.root_bindings(_WORLD_INTEGRATION, 9) == {
        ("file", "file-k"): "shared-a", ("file", "file-x"): "shared-c",
    }
    assert _unsettled(state) == {}
    assert _roots(state, world, "shared-c") == {("file", "file-x", "shared-c")}
    assert state.membership_ids(world.namespace("shared-c"), 9) == ["file-x"]
    assert state.membership_ids(world.namespace("shared-a"), 9) == ["file-k"]
    assert "file-x" in world.pushed
    assert onward.failed == 0 and onward.authoritative_complete is True and onward.backlog == 0
    # It was never absent: not removed, and in everything the connection reconciled to.
    assert world.removed == []
    assert world.reconciled == [["file-k", "file-x"], ["file-k", "file-x"]]
    assert {world.stream(drive)["phase"] for drive in ("shared-a", "shared-c")} == {"current"}
    state.close()


@pytest.mark.asyncio
async def test_relocating_root_moved_back_is_re_observed_and_stays_with_the_stream_it_never_left(
    tmp_path, monkeypatch,
):
    world, _path, state = await _relocation_stalled_on_an_unopenable_destination(
        tmp_path, monkeypatch, "relocation-b-to-a.sqlite",
    )

    # B→A: the root is moved back to the drive it is still bound to.
    world.move("file-x", source="shared-b", destination="shared-a")
    world.calls.clear()
    world.pushed.clear()
    back = await world.run(state)

    assert world.calls[0] == ("metadata", "file-x")
    assert ("start", "shared-b") not in world.calls
    assert state.get_progress(world.namespace("shared-b")) is None
    assert "shared-b" not in world.progress["streams"]
    assert _unsettled(state) == {}
    assert state.root_bindings(_WORLD_INTEGRATION, 9) == {
        ("file", "file-k"): "shared-a", ("file", "file-x"): "shared-a",
    }
    # The stream it never left enumerates it again, in a snapshot of both its roots.
    assert _roots(state, world, "shared-a") == {
        ("file", "file-k", "shared-a"), ("file", "file-x", "shared-a"),
    }
    assert state.membership_ids(world.namespace("shared-a"), 9) == ["file-k", "file-x"]
    assert "file-x" in world.pushed
    assert back.failed == 0 and back.authoritative_complete is True and back.backlog == 0
    assert world.removed == []
    assert world.reconciled == [["file-k", "file-x"], ["file-k", "file-x"]]
    assert world.stream("shared-a")["phase"] == "current"
    state.close()


# ---------------------------------------------------------------------------------------------
# A document moved between two selected roots is not removed from the connection
# ---------------------------------------------------------------------------------------------
#
# Spec. An explicit removal removes a document for the whole connection. A document — or a folder
# and everything under it — moved between selected roots in two drives is reported removed by the
# drive it left and present by the drive it entered, each in its own change log, read in either
# order. Neither order removes it: a removal leaves its stream only when no other stream of the
# connection claims the document and every other stream has drained past the moment the removal
# was observed. That holds across a restart. A document that really was deleted is still removed.


def _two_selected_folders(monkeypatch):
    world = _DriveWorld(folder_ids=["folder-a", "folder-b"]).install(monkeypatch)
    world.put("folder-a", drive="shared-a", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-a")
    world.put("doc-ka", drive="shared-a", parent="folder-a")
    world.put("folder-b", drive="shared-b", folder=True)
    world.put("doc-kb", drive="shared-b", parent="folder-b")
    return world


async def _run_until_next_is(world, state, drive_id):
    """Idle runs until ``drive_id`` is the stream the next run consumes first."""
    for _attempt in range(3):
        row = state._db.execute(
            "select next_drive_id from connection_stream_schedule where connection_id=? and generation=?",
            (_WORLD_INTEGRATION, world.generation),
        ).fetchone()
        if row and row["next_drive_id"] == drive_id:
            return
        assert (await world.run(state)).authoritative_complete is True
    raise AssertionError(f"{drive_id} never became the first stream of a run")


@pytest.mark.asyncio
async def test_document_moved_between_selected_roots_is_not_removed_when_its_destination_reads_first(
    tmp_path, monkeypatch,
):
    world = _two_selected_folders(monkeypatch)
    path = str(tmp_path / "cross-stream-destination-first.sqlite")
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    assert world.reconciled == [["doc-1", "doc-ka", "doc-kb"]]
    await _run_until_next_is(world, state, "shared-b")
    reconciliations = len(world.reconciled)

    world.move("doc-1", source="shared-a", destination="shared-b", parent="folder-b")
    world.calls.clear()
    world.pushed.clear()
    moved = await world.run(state)

    # The destination read its change log first, and claimed the document…
    assert (world.calls.index(("changes", "shared-b", "shared-b@0"))
            < world.calls.index(("changes", "shared-a", "shared-a@0")))
    assert world.pushed == ["doc-1"]
    # …so the removal the origin then read ended only the origin's own membership.
    assert world.removed == []
    assert state.membership_ids(world.namespace("shared-a"), 9) == ["doc-ka"]
    assert state.membership_ids(world.namespace("shared-b"), 9) == ["doc-1", "doc-kb"]
    assert state.pending_count(world.namespace("shared-a"), 9) == 0
    assert moved.failed == 0 and moved.authoritative_complete is True and moved.backlog == 0
    assert world.reconciled[reconciliations:] == [["doc-1", "doc-ka", "doc-kb"]]
    state.close()

    # A restart concludes nothing else from it.
    state = StateStore(path)
    again = await world.run(state)
    assert world.removed == []
    assert again.authoritative_complete is True
    assert world.reconciled[-1] == ["doc-1", "doc-ka", "doc-kb"]
    state.close()


@pytest.mark.asyncio
async def test_document_moved_between_selected_roots_is_withheld_across_a_restart_when_its_origin_reads_first(
    tmp_path, monkeypatch,
):
    world = _two_selected_folders(monkeypatch)
    path = str(tmp_path / "cross-stream-origin-first.sqlite")
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    await _run_until_next_is(world, state, "shared-a")
    reconciliations = len(world.reconciled)
    origin = world.namespace("shared-a")

    world.move("doc-1", source="shared-a", destination="shared-b", parent="folder-b")
    world.calls.clear()
    world.pushed.clear()
    withheld = await world.run(state)

    # The origin read the removal before the destination had read anything of the move…
    assert (world.calls.index(("changes", "shared-a", "shared-a@0"))
            < world.calls.index(("changes", "shared-b", "shared-b@0")))
    # …and removed nothing: the obligation is durable, and the connection is not complete.
    assert world.removed == []
    assert [(work.item_key, work.action) for work in state.list_pending(origin, 9)] == [("doc-1", "remove")]
    assert withheld.failed == 0
    assert withheld.failure_categories == {"cross_stream_move_pending": 1}
    assert withheld.authoritative_complete is False
    assert withheld.backlog is not None and withheld.backlog > 0
    assert world.reconciled[reconciliations:] == []
    assert world.pushed == ["doc-1"]
    state.close()

    # A restart. The destination claims the document, so the obligation ends without a removal.
    state = StateStore(path)
    settled = await world.run(state)

    assert world.removed == []
    assert state.pending_count(origin, 9) == 0
    assert state.membership_ids(origin, 9) == ["doc-ka"]
    assert state.membership_ids(world.namespace("shared-b"), 9) == ["doc-1", "doc-kb"]
    assert settled.failed == 0 and settled.authoritative_complete is True and settled.backlog == 0
    assert world.reconciled[reconciliations:] == [["doc-1", "doc-ka", "doc-kb"]]
    state.close()


@pytest.mark.asyncio
async def test_nested_folder_moved_between_selected_roots_keeps_every_descendant_claim(
    tmp_path, monkeypatch,
):
    world = _DriveWorld(folder_ids=["folder-a", "folder-b"]).install(monkeypatch)
    world.put("folder-a", drive="shared-a", folder=True)
    world.put("doc-ka", drive="shared-a", parent="folder-a")
    world.put("folder-n", drive="shared-a", parent="folder-a", folder=True)
    world.put("doc-n", drive="shared-a", parent="folder-n")
    world.put("folder-b", drive="shared-b", folder=True)
    world.put("doc-kb", drive="shared-b", parent="folder-b")
    path = str(tmp_path / "cross-stream-nested-folder.sqlite")
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    assert world.reconciled == [["doc-ka", "doc-kb", "doc-n"]]

    # The nested folder, with its document, moves under the other selected root. The old drive's
    # log reports the document removed and then the folder; the new drive's reports both present.
    world.move("doc-n", source="shared-a", destination="shared-b")
    world.move("folder-n", source="shared-a", destination="shared-b", parent="folder-b")

    summary = None
    for _run in range(4):
        summary = await world.run(state)
        # Whichever stream read first, and across every restart, nothing is ever removed and the
        # connection never reconciles to a snapshot without the descendant.
        assert world.removed == []
        assert all("doc-n" in members for members in world.reconciled)
        state.close()
        state = StateStore(path)
        if summary.authoritative_complete:
            break

    assert summary.authoritative_complete is True and summary.backlog == 0
    assert state.pending_count(world.namespace("shared-a"), 9) == 0
    assert state.membership_ids(world.namespace("shared-a"), 9) == ["doc-ka"]
    assert state.membership_ids(world.namespace("shared-b"), 9) == ["doc-kb", "doc-n"]
    assert world.reconciled[-1] == ["doc-ka", "doc-kb", "doc-n"]
    assert len(world.reconciled) == 2
    state.close()


@pytest.mark.asyncio
async def test_document_deleted_in_a_multi_stream_connection_is_removed_once_the_other_stream_has_drained(
    tmp_path, monkeypatch,
):
    world = _two_selected_folders(monkeypatch)
    path = str(tmp_path / "cross-stream-real-deletion.sqlite")
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    await _run_until_next_is(world, state, "shared-a")

    # Not a move: the document is gone, and no other stream will ever claim it.
    del world.files["doc-1"]
    world.logs.setdefault("shared-a", []).append({"fileId": "doc-1", "removed": True})
    first = await world.run(state)

    # The other stream had not drained past the removal when it was observed: nothing yet.
    assert world.removed == []
    assert first.authoritative_complete is False and first.backlog > 0
    state.close()

    # It has now, and does not claim the document: the removal is the connection's.
    state = StateStore(path)
    second = await world.run(state)

    assert world.removed == ["doc-1"]
    assert state.pending_count(world.namespace("shared-a"), 9) == 0
    assert second.authoritative_complete is True and second.backlog == 0
    assert world.reconciled[-1] == ["doc-ka", "doc-kb"]
    state.close()


# ---------------------------------------------------------------------------------------------
# A rescan seeded by a terminal change page is confirmed by a drain read after it enumerated
# ---------------------------------------------------------------------------------------------
#
# Spec. A change page that reports a folder change seeds a rescan of the stream's roots, and its
# cursor does not retire until that rescan is published. When that page was the terminal one, its
# token was read BEFORE the rescan enumerated anything — so a document moved between two folders
# of the subtree while it enumerated can be listed in neither, with a change after that token as
# its only record. The stream is therefore not drained, and the connection does not reconcile,
# until a change page read after the enumeration reaches the terminal token. A restart in between
# changes none of that.


@pytest.mark.asyncio
async def test_rescan_seeded_by_a_terminal_change_page_reconciles_only_after_a_later_drain_confirms_it(
    tmp_path, monkeypatch,
):
    world = _DriveWorld(folder_ids=["folder-r"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("folder-n1", drive="shared-a", parent="folder-r", folder=True)
    world.put("folder-n2", drive="shared-a", parent="folder-r", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-r")
    world.put("doc-m", drive="shared-a", parent="folder-n2")
    path = str(tmp_path / "terminal-page-seeded-rescan.sqlite")
    state = StateStore(path)
    namespace = world.namespace("shared-a")
    assert (await world.run(state)).authoritative_complete is True
    assert world.reconciled == [["doc-1", "doc-m"]]

    # A folder of the selected subtree changes. The page that reports it is terminal, and seeds a
    # rescan that keeps its cursor from retiring.
    world.logs["shared-a"].append({"fileId": "folder-n1", "file": dict(world.files["folder-n1"])})
    seeded = await world.run(state)

    page = state.next_uncommitted_page(namespace, 9)
    assert page is not None and page.rescan_snapshot_id is not None
    assert page.terminal_token == "shared-a@1" and page.next_token is None
    assert seeded.authoritative_complete is False and seeded.backlog > 0

    def move_between_listings():
        # `doc-m` leaves a folder the rescan has not listed yet for one it has just listed.
        world.files["doc-m"]["parents"] = ["folder-n1"]
        world.logs["shared-a"].append({"fileId": "doc-m", "file": dict(world.files["doc-m"])})

    world.hooks[("list", "shared-a", "folder-n1")] = move_between_listings
    # The first change page after the rescan cannot be read in this run.
    world.change_errors["shared-a"] = [
        ProviderDeferred("quota", not_before="2000-01-01T00:00:00+00:00", category="rate_limited"),
    ]
    world.calls.clear()
    enumerated = await world.run(state)

    assert (world.calls.index(("list", "shared-a", "folder-n1"))
            < world.calls.index(("list", "shared-a", "folder-n2")))
    progress = state.get_progress(namespace)
    # The rescan is published — without the document neither listing could see…
    assert progress.listing_complete is True and progress.building_snapshot is None
    assert state.membership_ids(namespace, 9) == ["doc-1"]
    # …the page that seeded it is retired, and the cursor is past it…
    assert state.next_uncommitted_page(namespace, 9) is None
    assert progress.page_token == "shared-a@1"
    # …but that page was read before the enumeration: it acknowledges no terminal drain, locally
    # or on the brain, and the connection reconciles to nothing on its word.
    assert progress.terminal_drain_acknowledged is False
    assert world.stream("shared-a")["terminal_drain_acknowledged"] is False
    assert world.stream("shared-a")["phase"] != "current"
    assert enumerated.failure_categories == {"rate_limited": 1}
    assert enumerated.authoritative_complete is False
    assert enumerated.backlog is not None and enumerated.backlog > 0
    assert world.reconciled == [["doc-1", "doc-m"]] and world.removed == []
    state.close()

    # A restart: the confirmation is still owed. The page after the enumeration is read, the move
    # it reports restores the document's claim, and only then does the connection reconcile.
    state = StateStore(path)
    assert state.get_progress(namespace).terminal_drain_acknowledged is False
    world.calls.clear()
    world.pushed.clear()
    confirmed = await world.run(state)

    assert ("changes", "shared-a", "shared-a@1") in world.calls
    assert not [call for call in world.calls if call[0] == "list"]
    assert world.pushed == ["doc-m"]
    assert state.membership_ids(namespace, 9) == ["doc-1", "doc-m"]
    assert state.get_progress(namespace).terminal_drain_acknowledged is True
    assert confirmed.failed == 0 and confirmed.authoritative_complete is True and confirmed.backlog == 0
    assert world.reconciled == [["doc-1", "doc-m"], ["doc-1", "doc-m"]]
    assert world.removed == []
    state.close()


# ---------------------------------------------------------------------------------------------
# A stream that holds no token never started, whatever its record says
# ---------------------------------------------------------------------------------------------
#
# Spec. A stream has started when it holds a change token. A record without one — its diagnostic
# written, replaced by another message, or never written because the run that created it was
# interrupted first — is a stream that never started: its drive is asked for a token before
# anything of it is enumerated, on every run, and it is complete only after a drain from that
# token reaches the terminal token.


@pytest.mark.parametrize("status", [403, 404])
@pytest.mark.asyncio
async def test_stream_record_left_without_a_token_by_an_interrupted_run_is_unstarted_whatever_it_says(
    tmp_path, monkeypatch, status,
):
    world = _DriveWorld(file_ids=["file-x", "file-m"]).install(monkeypatch)
    world.put("file-x", drive="shared-x")
    world.put("file-m", drive="my-drive")
    world.token_errors["shared-x"] = _ProviderHttpError(status)
    # The process dies while the refusal is being recorded: the local record exists by then.
    world.checkpoint_crashes["shared-x"] = [RuntimeError("process killed")]
    path = str(tmp_path / f"interrupted-start-{status}.sqlite")
    namespace = world.namespace("shared-x")
    diagnostic = _start_diagnostic("shared-x", status)
    state = StateStore(path)

    with pytest.raises(RuntimeError, match="process killed"):
        await world.run(state)
    state.close()

    # What the interruption left: a record with no token and no diagnostic, unknown to the brain.
    state = StateStore(path)
    interrupted = state.get_progress(namespace)
    assert interrupted is not None
    assert not interrupted.baseline_start_token and interrupted.page_token is None
    assert interrupted.last_error is None
    assert "shared-x" not in world.progress["streams"]

    def assert_nothing_of_the_drive_was_read():
        assert ("start", "shared-x") in world.calls
        assert not [call for call in world.calls if call[0] in {"changes", "list"} and call[1] == "shared-x"]
        assert ("metadata", "file-x") not in world.calls and ("doc", "file-x") not in world.calls
        assert world.pushed == ["file-m"]

    # A restart, the drive still refusing: the token is asked for again and nothing is enumerated.
    world.calls.clear()
    blocked = await world.run(state)

    assert_nothing_of_the_drive_was_read()
    assert blocked.failed == 1 and blocked.failure_categories == {"stream_start_unavailable": 1}
    local = state.get_progress(namespace)
    assert (local.phase, local.listing_complete, local.baseline_start_token) == ("partial", False, None)
    assert local.last_error == diagnostic
    assert world.stream("shared-x")["last_error"] == diagnostic
    assert world.stream("shared-x")["baseline_start_token"] is None
    assert blocked.authoritative_complete is False
    assert blocked.backlog is not None and blocked.backlog > 0
    assert world.reconciled == [] and world.removed == []

    # The diagnostic is then replaced, locally and on the brain, by an unrelated message. The
    # record still holds no token, so it is still a stream that never started.
    state.update_progress(namespace, last_error="overall run deadline exhausted")
    world.progress["streams"]["shared-x"]["last_error"] = "overall run deadline exhausted"
    state.close()
    state = StateStore(path)
    world.calls.clear()
    reworded = await world.run(state)

    assert_nothing_of_the_drive_was_read()
    assert reworded.failure_categories == {"stream_start_unavailable": 1}
    assert state.get_progress(namespace).last_error == diagnostic
    assert not state.get_progress(namespace).baseline_start_token
    assert reworded.authoritative_complete is False
    assert reworded.backlog is not None and reworded.backlog > 0
    assert world.reconciled == [] and world.removed == []
    state.close()

    # The drive issues a token: captured before its root is read, and the stream is complete only
    # once a drain from that token has reached the terminal token.
    state = StateStore(path)
    del world.token_errors["shared-x"]
    world.calls.clear()
    opened = await world.run(state)

    assert world.calls.index(("start", "shared-x")) < world.calls.index(("metadata", "file-x"))
    assert world.calls.index(("doc", "file-x")) < world.calls.index(("changes", "shared-x", "shared-x@0"))
    started = state.get_progress(namespace)
    assert started.baseline_start_token == "shared-x@0"
    assert started.terminal_drain_acknowledged is True
    assert opened.failed == 0 and opened.authoritative_complete is True and opened.backlog == 0
    assert world.pushed == ["file-m", "file-x"]
    assert world.reconciled == [["file-m", "file-x"]]
    assert {world.stream(drive)["phase"] for drive in ("my-drive", "shared-x")} == {"current"}
    state.close()


# ---------------------------------------------------------------------------------------------
# A build begun under one token is never resumed under another
# ---------------------------------------------------------------------------------------------
#
# Spec. A snapshot build is evidence only together with the token it was begun under: what it
# listed, and every change after that token. A recovery that captures a new token — for a record
# that holds none, or one whose local state is not what the brain acknowledged — resumes nothing
# of a build left unfinished. A folder that build had listed is listed again, because a document
# that entered it before the new token is in no change after it. Until the replacement is
# published the last published membership and every document obligation stand, and the
# connection reconciles only after a change page read from the new token reaches the terminal
# token. A drive that refuses the token changes nothing the stream holds.


async def _unfinished_rescan_with_a_listed_folder(tmp_path, monkeypatch, name, *, seeded_by):
    """A published snapshot, and a rescan of it that listed ``folder-r`` and then stopped.

    The rescan is begun by a rejected cursor, or seeded by a change page that reports a folder of
    the subtree and cannot retire before that rescan is published.
    """
    world = _DriveWorld(folder_ids=["folder-r"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("folder-n", drive="shared-a", parent="folder-r", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-r")
    world.put("doc-2", drive="shared-a", parent="folder-n")
    path = str(tmp_path / name)
    state = StateStore(path)
    namespace = world.namespace("shared-a")
    assert (await world.run(state)).authoritative_complete is True
    assert world.reconciled == [["doc-1", "doc-2"]]
    published = state.get_progress(namespace).active_snapshot

    if seeded_by == "invalid_cursor":
        world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
        assert (await world.run(state)).failure_categories.get("invalid_cursor") == 1
        world.cursor_errors.clear()
    else:
        world.logs["shared-a"].append({"fileId": "folder-n", "file": dict(world.files["folder-n"])})
        await world.run(state)
        assert state.next_uncommitted_page(namespace, 9).rescan_snapshot_id is not None
    build = state.get_progress(namespace).building_snapshot
    assert build is not None and build != published

    # The rescan lists `folder-r`, finding a document it cannot read yet, and the listing of
    # `folder-n` then fails: one folder listed, one obligation owed, and the build unfinished.
    world.put("doc-3", drive="shared-a", parent="folder-r")
    world.unreadable["doc-3"] = _ProviderHttpError(500)

    def listing_fails():
        raise _ProviderHttpError(500)

    world.hooks[("list", "shared-a", "folder-n")] = listing_fails
    world.calls.clear()
    await world.run(state)

    assert ("list", "shared-a", "folder-r") in world.calls
    assert state.next_traversal(namespace, 9)["folder_id"] == "folder-n"
    assert state.get_progress(namespace).building_snapshot == build
    assert state.membership_ids(namespace, 9) == ["doc-1", "doc-2"]
    assert [row[0] for row in _pending_rows(state, namespace)] == ["doc-3"]
    assert world.reconciled == [["doc-1", "doc-2"]] and world.removed == []
    return world, path, state, published, build


def _lose_stream_tokens(world, state, namespace):
    """The record keeps what was enumerated through it and loses both of its change tokens."""
    state.update_progress(namespace, baseline_start_token=None, page_token=None)
    world.progress["streams"]["shared-a"].update(baseline_start_token=None, page_token=None)


def _quota_deferral():
    return ProviderDeferred("quota", not_before="2000-01-01T00:00:00+00:00", category="rate_limited")


@pytest.mark.parametrize("status", [403, 404])
@pytest.mark.parametrize("lost", ["tokens", "checkpoint"])
@pytest.mark.asyncio
async def test_recovery_under_a_fresh_token_lists_again_what_an_unfinished_build_already_listed(
    tmp_path, monkeypatch, status, lost,
):
    world, path, state, published, build = await _unfinished_rescan_with_a_listed_folder(
        tmp_path, monkeypatch, f"fresh-token-unfinished-build-{lost}-{status}.sqlite",
        seeded_by="invalid_cursor",
    )
    namespace = world.namespace("shared-a")
    diagnostic = _start_diagnostic("shared-a", status)

    # A document enters the folder the build has already listed, and only then is a recovery
    # owed: the record loses its tokens, or the brain's checkpoint names a page this sidecar never
    # retired. The token that recovery will capture is past the document's change.
    world.put("doc-late", drive="shared-a", parent="folder-r")
    world.logs["shared-a"].append({"fileId": "doc-late", "file": dict(world.files["doc-late"])})
    fresh = "shared-a@1"
    if lost == "tokens":
        _lose_stream_tokens(world, state, namespace)
    else:
        world.progress["streams"]["shared-a"]["checkpoint_id"] = "page-this-sidecar-never-retired"
        world.revision += 1
    held = state.get_progress(namespace)
    world.token_errors["shared-a"] = _ProviderHttpError(status)

    for _run in range(2):
        state.close()
        state = StateStore(path)
        world.calls.clear()
        denied = await world.run(state)

        assert denied.failed == 1 and denied.failure_categories == {"stream_start_unavailable": 1}
        assert ("start", "shared-a") in world.calls
        assert not [call for call in world.calls if call[0] in {"changes", "list", "doc"}]
        local = state.get_progress(namespace)
        assert local.last_error == diagnostic
        assert world.stream("shared-a")["last_error"] == diagnostic
        # The refusal gave nothing up: the tokens the record held, the published membership, the
        # unfinished build and where it stopped, and the obligation it owes.
        assert (local.baseline_start_token, local.page_token) == (
            held.baseline_start_token, held.page_token,
        )
        assert (local.active_snapshot, local.building_snapshot) == (published, build)
        assert state.membership_ids(namespace, 9) == ["doc-1", "doc-2"]
        assert state.next_traversal(namespace, 9)["folder_id"] == "folder-n"
        assert [row[0] for row in _pending_rows(state, namespace)] == ["doc-3"]
        assert world.reconciled == [["doc-1", "doc-2"]] and world.removed == []
        assert denied.authoritative_complete is False
        assert denied.backlog is not None and denied.backlog > 0

    # The drive issues a token. It is captured before anything is listed, and the folder the
    # build had listed is listed again under it, so the document that entered it before the token
    # is found. The first change page from that token cannot be read in this run.
    del world.token_errors["shared-a"]
    del world.unreadable["doc-3"]
    world.change_errors["shared-a"] = [_quota_deferral()]
    state.close()
    state = StateStore(path)
    world.calls.clear()
    world.pushed.clear()
    recovered = await world.run(state)

    assert (world.calls.index(("start", "shared-a"))
            < world.calls.index(("list", "shared-a", "folder-r"))
            < world.calls.index(("list", "shared-a", "folder-n")))
    assert [call for call in world.calls if call[0] == "changes"] == [("changes", "shared-a", fresh)]
    progress = state.get_progress(namespace)
    # What was published is a new incarnation: neither the prior snapshot nor the build.
    assert progress.active_snapshot not in {published, build} and progress.building_snapshot is None
    assert progress.listing_complete is True and progress.recovery_required is False
    assert (progress.baseline_start_token, progress.page_token) == (fresh, fresh)
    assert state.membership_ids(namespace, 9) == ["doc-1", "doc-2", "doc-3", "doc-late"]
    assert sorted(world.pushed) == ["doc-1", "doc-2", "doc-3", "doc-late"]
    assert state.pending_count(namespace, 9) == 0
    # Published is not drained: no terminal page has been read from the new token, locally or on
    # the brain, and the connection reconciles to nothing yet.
    assert progress.terminal_drain_acknowledged is False
    assert world.stream("shared-a")["terminal_drain_acknowledged"] is False
    assert recovered.failure_categories == {"rate_limited": 1}
    assert recovered.authoritative_complete is False
    assert recovered.backlog is not None and recovered.backlog > 0
    assert world.reconciled == [["doc-1", "doc-2"]] and world.removed == []

    # A restart: the drain is still owed. The page from the new token is read, it is terminal, and
    # only then does the connection reconcile — to a membership that holds the late document.
    state.close()
    state = StateStore(path)
    world.calls.clear()
    world.pushed.clear()
    drained = await world.run(state)

    assert [call for call in world.calls if call[0] in {"changes", "list"}] == [
        ("changes", "shared-a", fresh),
    ]
    assert world.pushed == []
    assert state.get_progress(namespace).terminal_drain_acknowledged is True
    assert drained.failed == 0 and drained.authoritative_complete is True and drained.backlog == 0
    assert world.reconciled == [["doc-1", "doc-2"], ["doc-1", "doc-2", "doc-3", "doc-late"]]
    assert world.removed == []
    assert world.stream("shared-a")["phase"] == "current"
    state.close()


@pytest.mark.asyncio
async def test_change_page_read_before_a_fresh_token_neither_moves_the_cursor_nor_ends_its_drain(
    tmp_path, monkeypatch,
):
    world, path, state, published, build = await _unfinished_rescan_with_a_listed_folder(
        tmp_path, monkeypatch, "fresh-token-stale-change-page.sqlite", seeded_by="folder_change",
    )
    namespace = world.namespace("shared-a")
    # The page that seeded the build waits on it, holding the cursor the stream would move to.
    seeding = state.next_uncommitted_page(namespace, 9)
    assert seeding.page_kind == "changes" and seeding.rescan_snapshot_id == build
    assert seeding.terminal_token == "shared-a@1" and seeding.next_token is None

    world.put("doc-late", drive="shared-a", parent="folder-r")
    world.logs["shared-a"].append({"fileId": "doc-late", "file": dict(world.files["doc-late"])})
    fresh = "shared-a@2"
    _lose_stream_tokens(world, state, namespace)
    del world.unreadable["doc-3"]
    world.change_errors["shared-a"] = [_quota_deferral()]
    state.close()
    state = StateStore(path)
    world.calls.clear()
    recovered = await world.run(state)

    assert (world.calls.index(("start", "shared-a"))
            < world.calls.index(("list", "shared-a", "folder-r")))
    # The page read before the token is retired with the build it waited on. Its cursor is never
    # read: the only change page asked for is the one from the new token.
    assert state.next_uncommitted_page(namespace, 9) is None
    assert state.get_page(namespace, 9, seeding.page_id).committed_at is not None
    assert [call for call in world.calls if call[0] == "changes"] == [("changes", "shared-a", fresh)]
    progress = state.get_progress(namespace)
    assert progress.active_snapshot not in {published, build} and progress.building_snapshot is None
    assert (progress.baseline_start_token, progress.page_token) == (fresh, fresh)
    assert progress.checkpoint_id != seeding.page_id
    assert state.membership_ids(namespace, 9) == ["doc-1", "doc-2", "doc-3", "doc-late"]
    # Nothing that page said ends the drain the new token owes.
    assert progress.terminal_drain_acknowledged is False
    assert world.stream("shared-a")["terminal_drain_acknowledged"] is False
    assert recovered.authoritative_complete is False
    assert recovered.backlog is not None and recovered.backlog > 0
    assert world.reconciled == [["doc-1", "doc-2"]] and world.removed == []

    state.close()
    state = StateStore(path)
    world.calls.clear()
    drained = await world.run(state)

    assert [call for call in world.calls if call[0] in {"changes", "list"}] == [
        ("changes", "shared-a", fresh),
    ]
    assert state.get_progress(namespace).terminal_drain_acknowledged is True
    assert drained.failed == 0 and drained.authoritative_complete is True and drained.backlog == 0
    assert world.reconciled == [["doc-1", "doc-2"], ["doc-1", "doc-2", "doc-3", "doc-late"]]
    assert world.removed == []
    state.close()


def test_restarted_snapshot_supersedes_the_unfinished_build_and_retires_the_pages_before_it(tmp_path):
    state = StateStore(str(tmp_path / "restarted-snapshot.sqlite"))
    key = StreamKey("team", "connection", "account", "shared-a")
    peer = StreamKey("team", "connection", "account", "shared-b").namespace(4)
    namespace = state.begin_generation(key, 4, start_token="old-start").namespace
    roots = [("folder", "folder", "shared-a", True)]
    build = state.begin_selection_snapshot(namespace, 4, roots)
    state.materialize_page(
        namespace, 4, "baseline:folder", "baseline", None, None, None,
        [("doc-acked", "upsert", {"file_id": "doc-acked"}),
         ("doc-owed", "upsert", {"file_id": "doc-owed"})],
        snapshot_id=build,
        membership_additions=[
            ("doc-acked", "folder", "shared-a", "folder"),
            ("doc-owed", "folder", "shared-a", "folder"),
        ],
        traversal_completion=("folder", "folder", None),
    )
    work = {item.item_key: item for item in state.list_pending(namespace, 4)}
    state.ack_work(work["doc-acked"])
    state.materialize_page(
        namespace, 4, "changes:old-cursor", "changes", "old-cursor", None, "old-terminal", [],
        snapshot_id=build,
    )
    before = state.get_progress(namespace)

    # Under the token it was begun with, the build is resumed: its folder stays listed.
    assert state.begin_selection_snapshot(namespace, 4, roots) == build
    assert state.next_traversal(namespace, 4) is None

    restarted = state.restart_selection_snapshot(namespace, 4, roots, start_token="fresh-start")

    progress = state.get_progress(namespace)
    assert restarted > build and progress.building_snapshot == restarted
    assert (progress.baseline_start_token, progress.page_token) == ("fresh-start", None)
    assert progress.drain_observation == before.drain_observation + 1
    assert progress.terminal_drain_acknowledged is False
    # Nothing of the build is carried over, and it can never be published.
    assert state.next_traversal(namespace, 4)["folder_id"] == "folder"
    assert state.membership_ids(namespace, 4, snapshot_id=restarted) == []
    assert state.snapshot_build_complete(namespace, 4, build) is False
    # No page read before the token is left to finish; the work those pages owed is still owed.
    assert state.next_uncommitted_page(namespace, 4) is None
    assert [row[0] for row in _pending_rows(state, namespace)] == ["doc-owed"]
    assert state.work_membership_current(work["doc-owed"]) is True
    # What the superseded build listed stays claimed until its replacement is published without it.
    assert state.claimed_elsewhere("connection", 4, peer, "doc-acked") is True
    state.complete_traversal(namespace, 4, "folder", "folder", None, snapshot_id=restarted)
    state.publish_selection_snapshot(namespace, 4, restarted)
    assert state.claimed_elsewhere("connection", 4, peer, "doc-acked") is False
    state.close()


# ---------------------------------------------------------------------------------------------
# A removal is weighed against the whole roster, and waits on every peer it could have moved to
# ---------------------------------------------------------------------------------------------
#
# Spec. The streams of a connection are one roster, from every source: the drives its roots are
# configured for or bound to, the drive a root is on its way to, the streams local state holds
# and the streams the brain's checkpoint holds. A peer in the roster with no local state is
# unknown, never absent. A removal one stream observed leaves it only when no peer claims the
# document and every peer has finished a drain that began after its barrier — a durable mark,
# raised for each peer when it is first known for that removal, however much later that is. A
# peer with no barrier is one nothing is known about, across any restart. Behind a peer that
# cannot be read an ambiguous removal stays withheld; one the provider itself confirms — the
# document is not found, or is trashed — is the connection's at once, without a complete snapshot.


def _lose_local_stream(state, namespace):
    """Drop everything this sidecar holds for one stream; the brain's checkpoint keeps it."""
    for table in (
        "stream_progress", "selection_snapshots", "selection_roots", "traversal_queue",
        "selected_membership", "traversal_ancestry", "membership_ancestry", "materialized_pages",
        "pending_work", "stream_observation_revisions", "item_observations",
        "page_obligation_outcomes",
    ):
        state._db.execute(f"delete from {table} where namespace=?", (namespace,))
    state._db.commit()


def _barrier_peers(state, namespace):
    return [row[0] for row in state._db.execute(
        "select peer_drive_id from removal_barriers where namespace=? order by peer_drive_id",
        (namespace,),
    ).fetchall()]


def test_removal_barrier_is_missing_until_raised_and_passes_only_on_a_later_drain_across_restart(tmp_path):
    path = str(tmp_path / "removal-barrier.sqlite")
    key = StreamKey("team", "connection", "account", "shared-a")
    peer = StreamKey("team", "connection", "account", "shared-b")
    late = StreamKey("team", "connection", "account", "shared-c")
    state = StateStore(path)
    progress = state.begin_generation(key, 3, start_token="start")
    state.enqueue_work(progress.namespace, 3, "doc", "remove", {"file_id": "doc"})
    (work,) = state.list_pending(progress.namespace, 3)

    # A drain the peer finished before any barrier existed is not evidence about this removal.
    state.ack_stream_hint(peer, state.record_stream_hint(peer))
    assert state.pending_stream_hint(peer) is None
    assert state.removal_barrier(work, peer) == "missing"

    # Raised once: a second attempt neither moves it nor marks the peer dirty again.
    assert state.raise_removal_barrier(work, peer) is True
    assert state.raise_removal_barrier(work, peer) is False
    assert state.pending_stream_hint(peer) == 2
    assert state.removal_barrier(work, peer) == "standing"
    state.close()

    state = StateStore(path)
    assert state.removal_barrier(work, peer) == "standing"
    # An acknowledgment of an earlier sequence does not pass it; the one it was raised at does.
    state.ack_stream_hint(peer, 1)
    assert state.removal_barrier(work, peer) == "standing"
    state.ack_stream_hint(peer, 2)
    assert state.removal_barrier(work, peer) == "passed"
    # Renewed, it stands again at a new sequence: the earlier drain no longer passes it.
    assert state.raise_removal_barrier(work, peer, renew=True) is True
    assert state.removal_barrier(work, peer) == "standing"
    assert state.pending_stream_hint(peer) == 3
    # A peer first known later has no barrier, whatever any other peer has drained.
    assert state.removal_barrier(work, late) == "missing"
    assert state.raise_removal_barrier(work, late) is True
    assert state.removal_barrier(work, late) == "standing"
    assert _barrier_peers(state, progress.namespace) == ["shared-b", "shared-c"]

    # A newer observation of the document starts with no barrier at all…
    state.enqueue_work(progress.namespace, 3, "doc", "remove", {"file_id": "doc"})
    (newer,) = state.list_pending(progress.namespace, 3)
    assert newer.observation_revision > work.observation_revision
    assert _barrier_peers(state, progress.namespace) == []
    assert state.removal_barrier(newer, peer) == "missing"
    # …and an acknowledged removal leaves none behind.
    assert state.raise_removal_barrier(newer, peer) is True
    state.ack_work(newer)
    assert _barrier_peers(state, progress.namespace) == []
    state.close()


@pytest.mark.parametrize("moved,moves,origin_members,destination_members", [
    ("doc-1", [(("doc-1",), "folder-b")], ["doc-ka", "doc-n"], ["doc-1", "doc-kb"]),
    # A nested folder and the document under it: the old drive reports the document removed and
    # then the folder; only the folder is re-parented, so the document is found by descent.
    ("doc-n", [(("doc-n",), None), (("folder-n",), "folder-b")], ["doc-1", "doc-ka"], ["doc-kb", "doc-n"]),
])
@pytest.mark.asyncio
async def test_move_into_a_stream_only_the_brain_holds_is_not_removed_when_its_origin_reads_first(
    tmp_path, monkeypatch, moved, moves, origin_members, destination_members,
):
    world = _DriveWorld(folder_ids=["folder-a", "folder-b"]).install(monkeypatch)
    world.put("folder-a", drive="shared-a", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-a")
    world.put("doc-ka", drive="shared-a", parent="folder-a")
    world.put("folder-n", drive="shared-a", parent="folder-a", folder=True)
    world.put("doc-n", drive="shared-a", parent="folder-n")
    world.put("folder-b", drive="shared-b", folder=True)
    world.put("doc-kb", drive="shared-b", parent="folder-b")
    everything = ["doc-1", "doc-ka", "doc-kb", "doc-n"]
    path = str(tmp_path / f"remote-only-destination-{moved}.sqlite")
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    assert world.reconciled == [everything]
    await _run_until_next_is(world, state, "shared-a")
    reconciliations = len(world.reconciled)
    origin, destination = world.namespace("shared-a"), world.namespace("shared-b")

    # This sidecar loses what it held for the destination's stream. The brain still holds it.
    _lose_local_stream(state, destination)
    assert state.get_progress(destination) is None
    assert world.stream("shared-b")["baseline_start_token"] == "shared-b@0"

    for file_ids, parent in moves:
        world.move(*file_ids, source="shared-a", destination="shared-b", parent=parent)
    world.calls.clear()
    withheld = await world.run(state)

    # The origin read the removal before the destination's stream had any local state at all…
    assert (world.calls.index(("changes", "shared-a", "shared-a@0"))
            < world.calls.index(("start", "shared-b")))
    # …and removed nothing: a stream the brain holds is unknown here, not absent. The obligation
    # is durable, with a barrier for that stream, and the connection is not complete.
    assert world.removed == []
    assert [(work.item_key, work.action) for work in state.list_pending(origin, 9)] == [(moved, "remove")]
    assert _barrier_peers(state, origin) == ["shared-b"]
    assert withheld.failed == 0
    assert withheld.failure_categories.get("cross_stream_move_pending") == 1
    assert withheld.authoritative_complete is False
    assert withheld.backlog is not None and withheld.backlog > 0
    assert world.reconciled[reconciliations:] == []
    state.close()

    # Across restarts the destination's recovered stream claims the document, so the obligation
    # ends without a removal, and the connection never reconciles to a snapshot without it.
    summary = None
    for _run in range(4):
        state = StateStore(path)
        summary = await world.run(state)
        assert world.removed == []
        assert all(moved in members for members in world.reconciled)
        if summary.authoritative_complete:
            break
        state.close()

    assert summary.authoritative_complete is True and summary.backlog == 0
    assert state.pending_count(origin, 9) == 0 and _barrier_peers(state, origin) == []
    assert state.membership_ids(origin, 9) == origin_members
    assert state.membership_ids(destination, 9) == destination_members
    assert world.reconciled[reconciliations:] == [everything]
    state.close()


@pytest.mark.asyncio
async def test_barrier_a_peer_passed_before_its_local_state_was_lost_is_not_evidence_about_it(
    tmp_path, monkeypatch,
):
    world = _two_selected_folders(monkeypatch)
    path = str(tmp_path / "barrier-passed-then-lost.sqlite")
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    await _run_until_next_is(world, state, "shared-a")
    reconciliations = len(world.reconciled)
    origin, destination = world.namespace("shared-a"), world.namespace("shared-b")
    peer = StreamKey("team", _WORLD_INTEGRATION, "account", "shared-b")

    # The origin reads the removal first and withholds it; the destination then claims the
    # document and drains past the barrier.
    world.move("doc-1", source="shared-a", destination="shared-b", parent="folder-b")
    await world.run(state)
    (work,) = state.list_pending(origin, 9)
    assert (work.item_key, work.action) == ("doc-1", "remove")
    assert state.removal_barrier(work, peer) == "passed"
    assert "doc-1" in state.membership_ids(destination, 9)

    # Before the origin looks again, this sidecar loses the destination's stream — and with it
    # the membership that made the document claimed. The origin's stream is consumed first.
    _lose_local_stream(state, destination)
    assert state.rotate_streams(_WORLD_INTEGRATION, 9, ["shared-a", "shared-b"]) == ["shared-b", "shared-a"]
    state.close()
    state = StateStore(path)
    world.calls.clear()
    relost = await world.run(state)

    # The origin weighed its removal before the destination's stream was recovered: the barrier
    # that stream had passed proved nothing about a stream nothing is known of, so it stands
    # again and nothing was removed.
    assert world.calls.index(("metadata", "doc-1")) < world.calls.index(("start", "shared-b"))
    assert world.removed == []
    assert world.reconciled[reconciliations:] == []
    assert relost.authoritative_complete is False
    state.close()

    summary = None
    for _run in range(4):
        state = StateStore(path)
        summary = await world.run(state)
        assert world.removed == []
        assert all("doc-1" in members for members in world.reconciled)
        if summary.authoritative_complete:
            break
        state.close()

    assert summary.authoritative_complete is True and summary.backlog == 0
    assert state.pending_count(origin, 9) == 0 and _barrier_peers(state, origin) == []
    assert state.membership_ids(origin, 9) == ["doc-ka"]
    assert state.membership_ids(destination, 9) == ["doc-1", "doc-kb"]
    assert world.reconciled[reconciliations:] == [["doc-1", "doc-ka", "doc-kb"]]
    state.close()


@pytest.mark.asyncio
async def test_peer_first_known_after_a_removal_was_withheld_gets_its_own_barrier_and_is_waited_on(
    tmp_path, monkeypatch,
):
    world = _DriveWorld(file_ids=["file-kb"], folder_ids=["folder-a", "folder-b"]).install(monkeypatch)
    world.put("folder-a", drive="shared-a", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-a")
    world.put("doc-ka", drive="shared-a", parent="folder-a")
    world.put("folder-b", drive="shared-b", folder=True)
    world.put("doc-kb", drive="shared-b", parent="folder-b")
    world.put("file-kb", drive="shared-b")
    everything = ["doc-1", "doc-ka", "doc-kb", "file-kb"]
    path = str(tmp_path / "late-relocation-peer.sqlite")
    state = StateStore(path)
    assert (await world.run(state)).authoritative_complete is True
    assert world.reconciled == [everything]
    await _run_until_next_is(world, state, "shared-a")
    reconciliations = len(world.reconciled)
    origin = world.namespace("shared-a")
    peer_b = StreamKey("team", _WORLD_INTEGRATION, "account", "shared-b")
    peer_c = StreamKey("team", _WORLD_INTEGRATION, "account", "shared-c")

    # doc-1 moves under folder-b — and folder-b, with everything under it, moves on to shared-c,
    # a drive whose change log cannot be opened.
    world.move("doc-1", source="shared-a", destination="shared-b", parent="folder-b")
    world.move("doc-1", "doc-kb", "folder-b", source="shared-b", destination="shared-c")
    world.token_errors["shared-c"] = _ProviderHttpError(403)
    first = await world.run(state)

    # The origin withheld its removal behind the only peer there was. shared-c became one — the
    # destination of folder-b — only afterwards, in the same run.
    assert world.removed == [] and first.authoritative_complete is False
    assert [(work.item_key, work.action) for work in state.list_pending(origin, 9)] == [("doc-1", "remove")]
    assert _barrier_peers(state, origin) == ["shared-b"]
    assert _unsettled(state) == {("folder", "folder-b"): ("shared-b", "relocating", "shared-c")}
    assert state.get_progress(world.namespace("shared-c")) is None
    state.close()

    # shared-b goes on to drain past its barrier and no longer holds the document; shared-c still
    # cannot be opened. The removal stays withheld — behind a barrier of shared-c's own.
    for _run in range(3):
        state = StateStore(path)
        stalled = await world.run(state)
        assert world.removed == []
        assert stalled.authoritative_complete is False
        assert stalled.backlog is not None and stalled.backlog > 0
        assert world.reconciled[reconciliations:] == []
        assert [(work.item_key, work.action) for work in state.list_pending(origin, 9)] == [("doc-1", "remove")]
        assert not state.get_progress(world.namespace("shared-c")).baseline_start_token
        state.close()

    state = StateStore(path)
    assert "doc-1" not in state.membership_ids(world.namespace("shared-b"), 9)
    assert _barrier_peers(state, origin) == ["shared-b", "shared-c"]
    (work,) = state.list_pending(origin, 9)
    assert state.removal_barrier(work, peer_b) == "passed"
    assert state.removal_barrier(work, peer_c) == "standing"
    assert state.pending_stream_hint(peer_b) is None and state.pending_stream_hint(peer_c) is not None

    # shared-c opens: it takes folder-b over and claims the document. It was never removed.
    del world.token_errors["shared-c"]
    summary = None
    for _run in range(4):
        summary = await world.run(state)
        assert world.removed == []
        assert all("doc-1" in members for members in world.reconciled)
        state.close()
        state = StateStore(path)
        if summary.authoritative_complete:
            break

    assert summary.authoritative_complete is True and summary.backlog == 0
    assert state.pending_count(origin, 9) == 0 and _barrier_peers(state, origin) == []
    assert state.membership_ids(origin, 9) == ["doc-ka"]
    assert state.membership_ids(world.namespace("shared-b"), 9) == ["file-kb"]
    assert state.membership_ids(world.namespace("shared-c"), 9) == ["doc-1", "doc-kb"]
    assert world.reconciled[reconciliations:] == [everything]
    state.close()


async def _origin_baselined_while_its_peer_cannot_be_opened(tmp_path, monkeypatch, name):
    """folder-a's stream is baselined; folder-b's drive refuses its change log from the start."""
    world = _two_selected_folders(monkeypatch)
    world.token_errors["shared-b"] = _ProviderHttpError(403)
    path = str(tmp_path / name)
    state = StateStore(path)
    blocked = await world.run(state)
    assert blocked.failure_categories == {"stream_start_unavailable": 1}
    assert state.membership_ids(world.namespace("shared-a"), 9) == ["doc-1", "doc-ka"]
    # The connection has never had a complete snapshot, and cannot while shared-b is unreadable.
    assert blocked.authoritative_complete is False and world.reconciled == []
    return world, path, state


def _assert_peer_is_still_unopened(world, state):
    peer = state.get_progress(world.namespace("shared-b"))
    assert peer is not None and not peer.baseline_start_token and peer.active_snapshot is None
    assert world.stream("shared-b")["last_error"] == _start_diagnostic("shared-b", 403)


@pytest.mark.parametrize("ambiguity", ["readable-elsewhere", "unreadable"])
@pytest.mark.asyncio
async def test_ambiguous_removal_stays_withheld_behind_a_peer_that_cannot_be_opened_until_it_recovers(
    tmp_path, monkeypatch, ambiguity,
):
    world, path, state = await _origin_baselined_while_its_peer_cannot_be_opened(
        tmp_path, monkeypatch, f"blocked-peer-{ambiguity}.sqlite",
    )
    origin = world.namespace("shared-a")

    # doc-1 moves under the selected folder of the drive that cannot be opened. Its old drive
    # reports it removed; read for itself it is either still there to be read, or the read is
    # refused in a way that says nothing about it.
    world.move("doc-1", source="shared-a", destination="shared-b", parent="folder-b")
    if ambiguity == "unreadable":
        world.unreadable["doc-1"] = _ProviderHttpError(403)

    for _run in range(3):
        world.calls.clear()
        withheld = await world.run(state)

        # The document was read for itself, and that read did not make the removal absence.
        assert ("metadata", "doc-1") in world.calls
        assert world.removed == [] and world.reconciled == []
        assert [(work.item_key, work.action) for work in state.list_pending(origin, 9)] == [("doc-1", "remove")]
        assert _barrier_peers(state, origin) == ["shared-b"]
        assert withheld.failure_categories == {
            "stream_start_unavailable": 1, "cross_stream_move_pending": 1,
        }
        assert withheld.authoritative_complete is False
        assert withheld.backlog is not None and withheld.backlog > 0
        _assert_peer_is_still_unopened(world, state)
        state.close()
        state = StateStore(path)

    # The drive opens: its stream finds the document under folder-b and claims it.
    del world.token_errors["shared-b"]
    world.unreadable.clear()
    summary = None
    for _run in range(4):
        summary = await world.run(state)
        assert world.removed == []
        assert all("doc-1" in members for members in world.reconciled)
        state.close()
        state = StateStore(path)
        if summary.authoritative_complete:
            break

    assert summary.authoritative_complete is True and summary.backlog == 0
    assert state.pending_count(origin, 9) == 0 and _barrier_peers(state, origin) == []
    assert state.membership_ids(origin, 9) == ["doc-ka"]
    assert state.membership_ids(world.namespace("shared-b"), 9) == ["doc-1", "doc-kb"]
    assert world.reconciled == [["doc-1", "doc-ka", "doc-kb"]]
    state.close()


@pytest.mark.parametrize("loss", ["deleted", "access-lost", "trashed"])
@pytest.mark.asyncio
async def test_document_the_provider_says_is_gone_is_removed_at_once_behind_a_peer_that_cannot_be_opened(
    tmp_path, monkeypatch, loss,
):
    world, path, state = await _origin_baselined_while_its_peer_cannot_be_opened(
        tmp_path, monkeypatch, f"blocked-peer-{loss}.sqlite",
    )
    origin = world.namespace("shared-a")

    if loss == "trashed":
        world.files["doc-1"]["trashed"] = True
        world.logs.setdefault("shared-a", []).append(
            {"fileId": "doc-1", "file": dict(world.files["doc-1"])}
        )
    else:
        if loss == "deleted":
            del world.files["doc-1"]
        else:
            # The account no longer has the document: Drive answers as if it did not exist.
            world.unreadable["doc-1"] = _ProviderHttpError(404)
        world.logs.setdefault("shared-a", []).append({"fileId": "doc-1", "removed": True})
    world.calls.clear()
    promptly = await world.run(state)

    # The removal was read from the origin's change log, the document was then read for itself,
    # and the provider's own answer made it absence — in that run, with the peer still unopened
    # and no complete snapshot of the connection ever taken.
    assert (world.calls.index(("changes", "shared-a", "shared-a@0"))
            < world.calls.index(("metadata", "doc-1")))
    assert world.removed == ["doc-1"]
    assert world.reconciled == []
    assert state.pending_count(origin, 9) == 0 and _barrier_peers(state, origin) == []
    assert state.membership_ids(origin, 9) == ["doc-ka"]
    assert promptly.failure_categories == {"stream_start_unavailable": 1}
    assert promptly.authoritative_complete is False
    assert promptly.backlog is not None and promptly.backlog > 0
    _assert_peer_is_still_unopened(world, state)
    state.close()

    # A restart removes nothing again and concludes nothing else.
    state = StateStore(path)
    again = await world.run(state)
    assert world.removed == ["doc-1"] and world.reconciled == []
    assert state.pending_count(origin, 9) == 0
    assert again.authoritative_complete is False
    _assert_peer_is_still_unopened(world, state)
    state.close()


@pytest.mark.asyncio
async def test_deletion_the_provider_would_not_confirm_is_removed_once_the_unopened_peer_has_drained(
    tmp_path, monkeypatch,
):
    world, path, state = await _origin_baselined_while_its_peer_cannot_be_opened(
        tmp_path, monkeypatch, "blocked-peer-eventual-deletion.sqlite",
    )
    origin = world.namespace("shared-a")

    # The document is gone, but reading it for itself is refused throughout: nothing confirms it.
    del world.files["doc-1"]
    world.unreadable["doc-1"] = _ProviderHttpError(403)
    world.logs.setdefault("shared-a", []).append({"fileId": "doc-1", "removed": True})

    for _run in range(2):
        world.calls.clear()
        withheld = await world.run(state)
        assert ("metadata", "doc-1") in world.calls
        assert world.removed == [] and world.reconciled == []
        assert [(work.item_key, work.action) for work in state.list_pending(origin, 9)] == [("doc-1", "remove")]
        assert withheld.authoritative_complete is False
        _assert_peer_is_still_unopened(world, state)
        state.close()
        state = StateStore(path)

    # The drive opens. Its stream drains past the barrier and does not hold the document, so the
    # removal is the connection's — on that evidence alone: the document is never read again.
    del world.token_errors["shared-b"]
    summary = None
    for _run in range(4):
        world.calls.clear()
        summary = await world.run(state)
        assert ("metadata", "doc-1") not in world.calls
        assert all("doc-1" not in members for members in world.reconciled)
        state.close()
        state = StateStore(path)
        if summary.authoritative_complete:
            break

    assert summary.authoritative_complete is True and summary.backlog == 0
    assert world.removed == ["doc-1"]
    assert state.pending_count(origin, 9) == 0 and _barrier_peers(state, origin) == []
    assert state.membership_ids(origin, 9) == ["doc-ka"]
    assert state.membership_ids(world.namespace("shared-b"), 9) == ["doc-kb"]
    assert world.reconciled == [["doc-ka", "doc-kb"]]
    state.close()


# ---------------------------------------------------------------------------------------------
# A retired orphan stream leaves the brain's record, not just this run's copy of it
# ---------------------------------------------------------------------------------------------
#
# Spec. A stream that never started and that no root needs any more is forgotten — locally, and
# on the brain. The brain's record is its own copy: what a run is handed when it acquires the
# execution, what the brain stores at a checkpoint and what it acknowledges are three separate
# objects. The stream is gone only when a checkpoint of that run was written without it, and a
# later run, handed the brain's copy, neither finds nor opens it again.


@pytest.mark.asyncio
async def test_retired_orphan_stream_is_gone_from_the_brains_own_copy_and_stays_gone_after_a_restart(
    tmp_path, monkeypatch,
):
    world, path, state = await _relocation_stalled_on_an_unopenable_destination(
        tmp_path, monkeypatch, "orphan-retirement-deep-copy.sqlite",
    )
    world.ack_copies = True
    assert world.stream("shared-b")["last_error"] == _start_diagnostic("shared-b", 403)
    stored_before, revision = world.progress, world.revision

    # The root is moved back: no root lives in, or is on its way to, shared-b any more.
    world.move("file-x", source="shared-b", destination="shared-a")
    back = await world.run(state)

    assert state.get_progress(world.namespace("shared-b")) is None
    # It left through a checkpoint: the copy the brain held before is untouched, and the one it
    # holds now was written without the stream — at the top level as well as among the streams.
    assert "shared-b" in stored_before["streams"]
    assert world.revision > revision and world.progress is not stored_before
    assert sorted(world.progress["streams"]) == ["shared-a"]
    assert world.progress["drive_id"] == "shared-a"
    assert back.failed == 0 and back.authoritative_complete is True and back.backlog == 0
    state.close()

    # A restart is handed the brain's copy: the stream is not there, and is not opened again.
    state = StateStore(path)
    world.calls.clear()
    again = await world.run(state)

    assert not [call for call in world.calls if "shared-b" in call]
    assert state.get_progress(world.namespace("shared-b")) is None
    assert sorted(world.progress["streams"]) == ["shared-a"]
    assert [p.key.drive_id for p in state.list_progress(_WORLD_INTEGRATION, 9)] == ["shared-a"]
    assert again.failed == 0 and again.authoritative_complete is True and again.backlog == 0
    assert world.removed == []
    state.close()


# ---------------------------------------------------------------------------------------------
# What a replaced snapshot owed ends when its replacement is published without the document
# ---------------------------------------------------------------------------------------------
#
# Spec. An upsert is owed under the snapshot of the page that observed it, and that snapshot
# answers for it — a build before it is published, the authoritative snapshot after — until a
# replacement is published. Publication is one SQLite transaction, made after the brain
# acknowledged it: an upsert a replaced snapshot still owed for a document the published one does
# not hold is superseded there. It is never acknowledged, its page outcome names the snapshot
# that superseded it, it is neither backlog nor a claim any more, and a work object read before
# the publication cannot be pushed after it. An upsert for a document the replacement holds stays
# owed until it is ingested. A replacement that is unfinished, or that the brain refused, changes
# nothing; removals, their barriers and every other connection's obligations are untouched. The
# sidecar removes nothing to clear backlog: what the brain holds ends only with the fenced
# reconciliation of every stream, after a drain from the replacement's token reached the terminal
# token — and only for the connection that reconciled.


_SECOND_INTEGRATION = "00000000-0000-0000-0000-000000000042"
_HELD = "2999-01-01T00:00:00+00:00"
_ORIGINS = ("change-page", "superseded-build")
_LOSSES = ("deleted", "trashed", "nested-folder-moved-out")


class _ClaimLedger:
    """The brain's side of overlapping connections: a document stands while any of them claims it.

    A connection's claim begins with its push and ends only with its own reconciliation — a
    removal it names, or a complete snapshot of its own that does not hold the document.
    """

    def __init__(self):
        self.claims, self.retired, self.deleted = {}, [], []

    def push(self, connection_id, provider_id):
        self.claims.setdefault(provider_id, set()).add(connection_id)

    def reconcile(self, connection_id, *, removed=(), complete=None):
        for provider_id, holders in self.claims.items():
            if connection_id not in holders:
                continue
            if provider_id in removed or (complete is not None and provider_id not in complete):
                holders.discard(connection_id)
                self.retired.append((connection_id, provider_id))
                if not holders:
                    self.deleted.append(provider_id)


def _listing_fails():
    raise _ProviderHttpError(500)


def _retry_at(state, namespace, item_key, not_before):
    """Hold one document's retry (a time far ahead) or let it arrive (``None``)."""
    state._db.execute(
        "update pending_work set not_before=? where namespace=? and item_key=?",
        (not_before, namespace, item_key),
    )
    state._db.commit()


def _upsert_rows(state, namespace, item_key):
    """``(acknowledged, superseded)`` of the durable upsert row of one document."""
    return [
        (row["acknowledged_at"] is not None, row["superseded_at"] is not None)
        for row in state._db.execute(
            "select acknowledged_at,superseded_at from pending_work "
            "where namespace=? and item_key=? and action='upsert'",
            (namespace, item_key),
        ).fetchall()
    ]


def _page_outcomes(state, namespace, item_key):
    """Each page outcome of one document, in observation order, with the snapshot that ended it."""
    return [
        (row["status"], row["superseded_by_snapshot"])
        for row in state._db.execute(
            "select status,superseded_by_snapshot from page_obligation_outcomes "
            "where namespace=? and item_key=? order by observation_revision",
            (namespace, item_key),
        ).fetchall()
    ]


async def _upsert_owed_under_a_snapshot_being_replaced(
    tmp_path, monkeypatch, name, *, origin, loss, known=False, ledger=None,
):
    """A stream that owes ``doc-x`` an upsert, and whose snapshot is being replaced without it.

    The upsert is owed from a change page of the published snapshot, or from a build that listed
    the document and was left unfinished. Its retry is held. Before a fresh token is captured the
    document is deleted, trashed, or its folder is moved out of the selected root; the recovery
    that captures that token begins a replacement, which is left with nothing listed. ``known``
    is a document the published snapshot already held and the brain had already ingested.
    """
    world = _DriveWorld(folder_ids=["folder-r"]).install(monkeypatch)
    world.ledger = ledger
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("folder-n", drive="shared-a", parent="folder-r", folder=True)
    world.put("folder-z", drive="shared-a", parent="folder-r", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-r")
    if known:
        world.put("doc-x", drive="shared-a", parent="folder-n")
    path = str(tmp_path / name)
    state = StateStore(path)
    namespace = world.namespace("shared-a")
    assert (await world.run(state)).authoritative_complete is True
    published = state.get_progress(namespace).active_snapshot
    members = state.membership_ids(namespace, 9)
    assert world.reconciled == [members]

    # The document's upsert cannot be delivered: it stays owed, under the snapshot that saw it.
    if not known:
        world.put("doc-x", drive="shared-a", parent="folder-n")
    world.unreadable["doc-x"] = _ProviderHttpError(500)
    build = None
    if origin == "change-page":
        world.logs["shared-a"].append({"fileId": "doc-x", "file": dict(world.files["doc-x"])})
        await world.run(state)
    else:
        world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
        assert (await world.run(state)).failure_categories.get("invalid_cursor") == 1
        world.cursor_errors.clear()
        build = state.get_progress(namespace).building_snapshot
        # The build lists the document's folder, and the listing of another folder then fails.
        world.hooks[("list", "shared-a", "folder-z")] = _listing_fails
        await world.run(state)
        assert state.get_progress(namespace).building_snapshot == build
        assert state.next_traversal(namespace, 9)["folder_id"] == "folder-z"
    assert state.get_progress(namespace).active_snapshot == published
    assert [row[:2] for row in _pending_rows(state, namespace)] == [("doc-x", 1)]
    # The work object as a drain reads it, and then no retry until the test lets one arrive.
    _retry_at(state, namespace, "doc-x", None)
    (saved,) = state.list_pending(namespace, 9)
    _retry_at(state, namespace, "doc-x", _HELD)

    # Before the token the recovery will capture, the document leaves the selection.
    del world.unreadable["doc-x"]
    if loss == "deleted":
        del world.files["doc-x"]
        world.logs["shared-a"].append({"fileId": "doc-x", "removed": True})
    elif loss == "trashed":
        world.files["doc-x"]["trashed"] = True
        world.logs["shared-a"].append({"fileId": "doc-x", "file": dict(world.files["doc-x"])})
    else:
        # Still readable, under a folder the snapshot being replaced had traversed.
        world.files["folder-n"]["parents"] = ["outside"]
        world.logs["shared-a"].append({"fileId": "folder-n", "file": dict(world.files["folder-n"])})
    fresh = f"shared-a@{len(world.logs['shared-a'])}"

    # The recovery captures that token and begins a replacement, whose first listing fails.
    world.hooks[("list", "shared-a", "folder-r")] = _listing_fails
    world.calls.clear()
    if origin == "change-page":
        world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
        assert (await world.run(state)).failure_categories.get("invalid_cursor") == 1
        world.cursor_errors.clear()
    else:
        _lose_stream_tokens(world, state, namespace)
    await world.run(state)

    progress = state.get_progress(namespace)
    replacement = progress.building_snapshot
    assert replacement is not None and replacement not in {published, build}
    assert progress.active_snapshot == published and progress.baseline_start_token == fresh
    assert state.next_traversal(namespace, 9)["folder_id"] == "folder-r"
    # Begun is not published: the upsert is owed, answered for and claimed exactly as before, and
    # nothing was read, pushed, reconciled or removed for the document.
    assert state.pending_count(namespace, 9) == 1
    assert _upsert_rows(state, namespace, "doc-x") == [(False, False)]
    assert state.work_membership_current(saved) is True
    assert state.claimed_elsewhere(
        world.integration_id, 9, world.namespace("shared-b"), "doc-x",
    ) is True
    assert not [call for call in world.calls if call[1:] == ("doc-x",)]
    assert known or "doc-x" not in world.pushed
    assert world.reconciled == [members] and world.removed == []
    return SimpleNamespace(
        world=world, path=path, state=state, namespace=namespace, published=published,
        replacement=replacement, fresh=fresh, saved=saved,
    )


@pytest.mark.parametrize("loss", _LOSSES)
@pytest.mark.parametrize("origin", _ORIGINS)
@pytest.mark.asyncio
async def test_upsert_owed_under_a_replaced_snapshot_is_superseded_when_its_replacement_publishes_without_it(
    tmp_path, monkeypatch, origin, loss,
):
    held = await _upsert_owed_under_a_snapshot_being_replaced(
        tmp_path, monkeypatch, f"replaced-snapshot-{origin}-{loss}.sqlite", origin=origin, loss=loss,
    )
    world, namespace = held.world, held.namespace
    peer = world.namespace("shared-b")

    # A restart of the sidecar. The replacement lists every root and is published without the
    # document; the first change page from its token cannot be read in this run.
    world.change_errors["shared-a"] = [_quota_deferral()]
    held.state.close()
    state = StateStore(held.path)
    world.calls.clear()
    world.pushed.clear()
    replaced = await world.run(state)

    progress = state.get_progress(namespace)
    assert progress.active_snapshot == held.replacement and progress.building_snapshot is None
    assert state.membership_ids(namespace, 9) == ["doc-1"]
    assert world.pushed == ["doc-1"]
    # The upsert ended with the publication: superseded, not acknowledged, and its page outcome
    # names the snapshot that replaced the one it was owed under. It is no backlog and no claim.
    assert state.pending_count(namespace, 9) == 0
    assert _upsert_rows(state, namespace, "doc-x") == [(False, True)]
    assert _page_outcomes(state, namespace, "doc-x") == [("superseded", held.replacement)]
    assert state.claimed_elsewhere(world.integration_id, 9, peer, "doc-x") is False
    assert not [call for call in world.calls if call[1:] == ("doc-x",)]
    # Published is not drained: nothing is reconciled, and nothing was removed to clear backlog.
    assert progress.terminal_drain_acknowledged is False
    assert replaced.failure_categories == {"rate_limited": 1}
    assert replaced.authoritative_complete is False
    assert replaced.backlog is not None and replaced.backlog > 0
    assert world.reconciled == [["doc-1"]] and world.removed == []

    # The retry time arrives. The work object read before the publication is not current, is not
    # listed again, and cannot be delivered: the sink is never called for it.
    _retry_at(state, namespace, "doc-x", None)
    assert state.list_pending(namespace, 9) == []
    assert state.work_is_current(held.saved) is False
    assert state.work_membership_current(held.saved) is False
    brain = _RecordingBrain()
    stale = IngestSummary("docs", failure_categories={})
    assert await _push_doc(
        brain, GdriveExecution(world.integration_id, 9, 1, "owner", "later", "scope", {}),
        RawDoc(source="gdrive", external_id="doc-x", title="doc-x", body="stale"),
        Connection("docs", "gdrive"), state, namespace, 9, stale, held.saved,
    ) is True
    assert brain.pushed == [] and brain.revision == 0 and stale.failed == 0

    # A restart retries nothing of it. The page from the new token is read, it is terminal, and
    # only then does the connection reconcile — to exactly the replacement's membership.
    state.close()
    state = StateStore(held.path)
    world.calls.clear()
    world.pushed.clear()
    drained = await world.run(state)

    assert [call for call in world.calls if call[0] in {"changes", "list"}] == [
        ("changes", "shared-a", held.fresh),
    ]
    assert not [call for call in world.calls if call[1:] == ("doc-x",)]
    assert world.pushed == []
    assert state.get_progress(namespace).terminal_drain_acknowledged is True
    assert drained.failed == 0 and drained.authoritative_complete is True and drained.backlog == 0
    assert state.membership_ids(namespace, 9) == ["doc-1"]
    assert world.reconciled == [["doc-1"], ["doc-1"]] and world.removed == []
    assert world.stream("shared-a")["phase"] == "current"
    assert _upsert_rows(state, namespace, "doc-x") == [(False, True)]
    state.close()


@pytest.mark.asyncio
async def test_replacement_the_brain_refuses_to_publish_keeps_what_the_replaced_snapshot_owed(
    tmp_path, monkeypatch,
):
    held = await _upsert_owed_under_a_snapshot_being_replaced(
        tmp_path, monkeypatch, "replaced-snapshot-refused.sqlite",
        origin="change-page", loss="deleted",
    )
    world, state, namespace = held.world, held.state, held.namespace
    peer = world.namespace("shared-b")

    # The replacement lists every root, and the brain refuses the checkpoint that publishes it.
    world.checkpoint_faults.append(
        lambda progress: BrainError(409, "progress_conflict", "refused")
        if progress.get("active_snapshot") == held.replacement else None
    )
    refused = await world.run(state)

    assert refused.failed == 1 and refused.failure_categories == {"progress_conflict": 1}
    assert state.next_traversal(namespace, 9) is None
    progress = state.get_progress(namespace)
    assert (progress.active_snapshot, progress.building_snapshot) == (held.published, held.replacement)
    assert world.stream("shared-a")["active_snapshot"] == held.published
    # Nothing was decided: the upsert is owed, answered for and claimed as it was.
    assert state.pending_count(namespace, 9) == 1
    assert _upsert_rows(state, namespace, "doc-x") == [(False, False)]
    assert _page_outcomes(state, namespace, "doc-x") == [("pending", None)]
    assert state.work_membership_current(held.saved) is True
    assert state.claimed_elsewhere(world.integration_id, 9, peer, "doc-x") is True
    assert refused.authoritative_complete is False
    assert world.reconciled == [["doc-1"]] and world.removed == []
    state.close()

    # A restart: the brain accepts the publication, and only then is the upsert superseded.
    state = StateStore(held.path)
    world.calls.clear()
    accepted = await world.run(state)

    assert not [call for call in world.calls if call[0] == "list" or call[1:] == ("doc-x",)]
    assert state.get_progress(namespace).active_snapshot == held.replacement
    assert state.pending_count(namespace, 9) == 0
    assert _upsert_rows(state, namespace, "doc-x") == [(False, True)]
    assert _page_outcomes(state, namespace, "doc-x") == [("superseded", held.replacement)]
    assert state.claimed_elsewhere(world.integration_id, 9, peer, "doc-x") is False
    assert accepted.failed == 0 and accepted.authoritative_complete is True and accepted.backlog == 0
    assert world.reconciled == [["doc-1"], ["doc-1"]] and world.removed == []
    state.close()


@pytest.mark.parametrize("origin", _ORIGINS)
@pytest.mark.asyncio
async def test_publication_the_brain_acknowledged_and_sqlite_never_recorded_recovers_the_same_supersession(
    tmp_path, monkeypatch, origin,
):
    held = await _upsert_owed_under_a_snapshot_being_replaced(
        tmp_path, monkeypatch, f"replaced-snapshot-ack-then-crash-{origin}.sqlite",
        origin=origin, loss="nested-folder-moved-out",
    )
    world, state, namespace = held.world, held.state, held.namespace
    peer = world.namespace("shared-b")

    # The brain acknowledges the publication, and the process dies before SQLite records it.
    def killed(*_args, **_kwargs):
        raise RuntimeError("process killed")

    state.publish_selection_snapshot = killed
    with pytest.raises(RuntimeError, match="process killed"):
        await world.run(state)
    state.close()

    assert world.stream("shared-a")["active_snapshot"] == held.replacement
    assert world.stream("shared-a")["building_snapshot"] is None
    state = StateStore(held.path)
    progress = state.get_progress(namespace)
    assert (progress.active_snapshot, progress.building_snapshot) == (held.published, held.replacement)
    # Locally nothing was decided, and nothing is lost: the upsert is owed and claimed.
    assert state.pending_count(namespace, 9) == 1
    assert _upsert_rows(state, namespace, "doc-x") == [(False, False)]
    assert state.claimed_elsewhere(world.integration_id, 9, peer, "doc-x") is True

    # The retry time arrives before the restarted sidecar runs. The publication is recovered
    # first, with the decision it carries — so the document, still readable under a folder only
    # the replaced snapshot traversed, is neither read nor pushed.
    _retry_at(state, namespace, "doc-x", None)
    world.calls.clear()
    world.pushed.clear()
    recovered = await world.run(state)

    assert [call for call in world.calls if call[0] in {"start", "list", "changes"}] == [
        ("changes", "shared-a", held.fresh),
    ]
    assert not [call for call in world.calls if call[1:] == ("doc-x",)]
    assert world.pushed == []
    progress = state.get_progress(namespace)
    assert progress.active_snapshot == held.replacement and progress.building_snapshot is None
    assert state.pending_count(namespace, 9) == 0
    assert _upsert_rows(state, namespace, "doc-x") == [(False, True)]
    assert _page_outcomes(state, namespace, "doc-x") == [("superseded", held.replacement)]
    assert state.work_membership_current(held.saved) is False
    assert state.claimed_elsewhere(world.integration_id, 9, peer, "doc-x") is False
    assert recovered.failed == 0 and recovered.authoritative_complete is True
    assert recovered.backlog == 0
    assert world.reconciled == [["doc-1"], ["doc-1"]] and world.removed == []
    state.close()


@pytest.mark.parametrize("failure", ["malformed", "inaccessible"])
@pytest.mark.asyncio
async def test_selected_document_that_cannot_be_ingested_stays_owed_through_a_replacement_that_holds_it(
    tmp_path, monkeypatch, failure,
):
    world = _DriveWorld(folder_ids=["folder-r"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-r")
    path = str(tmp_path / f"replaced-snapshot-still-selected-{failure}.sqlite")
    state = StateStore(path)
    namespace = world.namespace("shared-a")
    assert (await world.run(state)).authoritative_complete is True

    # A document enters the selection that cannot be ingested: its required content is missing,
    # or it cannot be read for now. Its upsert is owed from a change page of the snapshot.
    world.put("doc-bad", drive="shared-a", parent="folder-r")
    world.logs["shared-a"].append({"fileId": "doc-bad", "file": dict(world.files["doc-bad"])})
    if failure == "malformed":
        world.malformed.add("doc-bad")
    else:
        world.unreadable["doc-bad"] = _ProviderHttpError(503)
    await world.run(state)
    assert [row[:2] for row in _pending_rows(state, namespace)] == [("doc-bad", 1)]
    _retry_at(state, namespace, "doc-bad", _HELD)
    replaced = state.get_progress(namespace).active_snapshot

    # The cursor is rejected. The replacement, under a fresh token, lists the document again.
    world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
    assert (await world.run(state)).failure_categories.get("invalid_cursor") == 1
    world.cursor_errors.clear()
    state.close()
    state = StateStore(path)
    world.pushed.clear()
    published = await world.run(state)

    progress = state.get_progress(namespace)
    assert progress.active_snapshot != replaced and progress.building_snapshot is None
    assert state.membership_ids(namespace, 9) == ["doc-1", "doc-bad"]
    assert world.pushed == ["doc-1"]
    # Its upsert is still owed — to the replacement that holds it, which observed it again. That
    # newer observation, not the publication, ended the older one; nothing is superseded by a
    # snapshot, and the stream is not complete.
    assert state.pending_count(namespace, 9) == 1
    assert _upsert_rows(state, namespace, "doc-bad") == [(False, False)]
    assert _page_outcomes(state, namespace, "doc-bad") == [("superseded", None), ("pending", None)]
    (owed,) = _pending_rows(state, namespace)
    assert owed[:2] == ("doc-bad", 1) and owed[2]
    assert published.failed == 1 and published.authoritative_complete is False
    assert published.backlog is not None and published.backlog > 0
    assert world.reconciled == [["doc-1"]] and world.removed == []

    # The document becomes ingestible and its retry time arrives: it is pushed, and only then
    # does the connection reconcile, to a membership that holds it.
    world.malformed.discard("doc-bad")
    world.unreadable.pop("doc-bad", None)
    _retry_at(state, namespace, "doc-bad", None)
    state.close()
    state = StateStore(path)
    world.pushed.clear()
    ingested = await world.run(state)

    assert world.pushed == ["doc-bad"]
    assert state.pending_count(namespace, 9) == 0
    assert ingested.failed == 0 and ingested.authoritative_complete is True and ingested.backlog == 0
    assert world.reconciled == [["doc-1"], ["doc-1", "doc-bad"]] and world.removed == []
    state.close()


@pytest.mark.asyncio
async def test_superseded_upsert_removes_nothing_itself_and_another_connections_claim_keeps_the_document(
    tmp_path, monkeypatch,
):
    ledger = _ClaimLedger()
    name = "replaced-snapshot-overlapping-connection.sqlite"
    # Another connection of the same sidecar selects the document directly, and has ingested it.
    second = _DriveWorld(file_ids=["doc-x"], integration_id=_SECOND_INTEGRATION).install(monkeypatch)
    second.ledger = ledger
    second.put("doc-x", drive="shared-a")
    state = StateStore(str(tmp_path / name))
    assert (await second.run(state)).authoritative_complete is True
    state.close()
    assert ledger.claims == {"doc-x": {_SECOND_INTEGRATION}}

    # This connection ingested it too, through a folder, and owes it a newer upsert when that
    # folder is moved out of its selected root.
    held = await _upsert_owed_under_a_snapshot_being_replaced(
        tmp_path, monkeypatch, name, origin="change-page", loss="nested-folder-moved-out",
        known=True, ledger=ledger,
    )
    world, state, namespace = held.world, held.state, held.namespace
    theirs = second.namespace("shared-a")
    assert ledger.claims["doc-x"] == {_SECOND_INTEGRATION, _WORLD_INTEGRATION}
    assert ledger.retired == []

    # The replacement is published without the document, drained and reconciled.
    world.pushed.clear()
    reconciled = await world.run(state)

    assert reconciled.failed == 0 and reconciled.authoritative_complete is True
    assert _upsert_rows(state, namespace, "doc-x") == [(False, True)]
    assert world.pushed == ["doc-1"]
    # The sidecar named no removal. This connection's claim ended with its own complete snapshot,
    # and the document stands: the other connection still claims it.
    assert world.removed == [] and world.reconciled[-1] == ["doc-1"]
    assert ledger.retired == [(_WORLD_INTEGRATION, "doc-x")]
    assert ledger.claims["doc-x"] == {_SECOND_INTEGRATION} and ledger.deleted == []
    # Nothing of the other connection's local state was touched.
    assert state.membership_ids(theirs, 9) == ["doc-x"]
    assert state.claimed_elsewhere(
        _SECOND_INTEGRATION, 9, second.namespace("shared-b"), "doc-x",
    ) is True

    second.install(monkeypatch)
    again = await second.run(state)
    assert again.failed == 0 and again.authoritative_complete is True
    assert second.removed == [] and second.reconciled[-1] == ["doc-x"]
    assert ledger.claims["doc-x"] == {_SECOND_INTEGRATION} and ledger.deleted == []
    state.close()


def test_publication_ends_only_the_upserts_replaced_snapshots_owed_for_documents_the_replacement_lacks(
    tmp_path,
):
    path = str(tmp_path / "publication-supersession.sqlite")
    state = StateStore(path)
    key = StreamKey("team", "connection", "account", "shared-a")
    other = StreamKey("team", "connection", "account", "shared-b")
    peer = other.namespace(4)
    namespace = state.begin_generation(key, 4, start_token="start").namespace
    roots = [("folder", "folder", "shared-a", True)]
    first = state.begin_selection_snapshot(namespace, 4, roots)
    state.materialize_page(
        namespace, 4, "baseline:folder", "baseline", None, None, None,
        [("doc-gone", "upsert", {"file_id": "doc-gone"}),
         ("doc-kept", "upsert", {"file_id": "doc-kept"})],
        snapshot_id=first,
        membership_additions=[
            ("doc-gone", "folder", "shared-a", "folder"),
            ("doc-kept", "folder", "shared-a", "folder"),
            ("doc-removed", "folder", "shared-a", "folder"),
        ],
        traversal_completion=("folder", "folder", None),
    )
    work = {item.item_key: item for item in state.list_pending(namespace, 4)}
    # Owed under a build: the build answers for it before it is published…
    assert state.get_progress(namespace).active_snapshot is None
    assert state.work_snapshot_id(work["doc-gone"]) == first
    assert state.work_membership_current(work["doc-gone"]) is True
    state.publish_selection_snapshot(namespace, 4, first)
    # …and goes on answering for it as the authoritative snapshot. Publishing ends nothing owed
    # under the snapshot being published.
    assert state.work_snapshot_id(work["doc-gone"]) == first
    assert state.work_membership_current(work["doc-gone"]) is True
    assert state.pending_count(namespace, 4) == 2

    # A removal the published snapshot's change page observed, withheld behind a peer's barrier.
    state.materialize_page(
        namespace, 4, "changes:cursor", "changes", "cursor", None, "terminal",
        [("doc-removed", "remove", {"file_id": "doc-removed"})],
        snapshot_id=first, membership_removals=["doc-removed"],
    )
    work.update({item.item_key: item for item in state.list_pending(namespace, 4)})
    assert state.raise_removal_barrier(work["doc-removed"], other) is True

    # Another connection in the same state file owes the same document under its own snapshot.
    theirs = state.begin_generation(
        StreamKey("team", "other-connection", "account", "shared-a"), 4, start_token="start",
    ).namespace
    their_snapshot = state.begin_selection_snapshot(theirs, 4, roots)
    state.materialize_page(
        theirs, 4, "baseline:folder", "baseline", None, None, None,
        [("doc-gone", "upsert", {"file_id": "doc-gone"})], snapshot_id=their_snapshot,
        membership_additions=[("doc-gone", "folder", "shared-a", "folder")],
        traversal_completion=("folder", "folder", None),
    )
    state.publish_selection_snapshot(theirs, 4, their_snapshot)
    (their_work,) = state.list_pending(theirs, 4)

    # A replacement under a fresh token holds one of the two documents still owed.
    replacement = state.restart_selection_snapshot(namespace, 4, roots, start_token="fresh")
    state.record_membership(
        namespace, 4, "doc-kept", "folder", "shared-a", snapshot_id=replacement,
    )
    # Until it is published, the snapshot each upsert was owed under answers for it; a
    # replacement that cannot be published yet ends nothing.
    with pytest.raises(RuntimeError, match="incomplete selection traversal"):
        state.publish_selection_snapshot(namespace, 4, replacement)
    assert state.work_snapshot_id(work["doc-gone"]) == first
    assert state.work_membership_current(work["doc-gone"]) is True
    assert state.claimed_elsewhere("connection", 4, peer, "doc-gone") is True
    assert state.pending_count(namespace, 4) == 3
    assert _upsert_rows(state, namespace, "doc-gone") == [(False, False)]

    state.complete_traversal(namespace, 4, "folder", "folder", None, snapshot_id=replacement)
    state.publish_selection_snapshot(namespace, 4, replacement)
    state.close()
    state = StateStore(path)

    # The upsert for the document the replacement lacks is superseded — not acknowledged — with
    # the snapshot that did it, and is no longer current, backlog or a claim.
    assert sorted((item.item_key, item.action) for item in state.list_pending(namespace, 4)) == [
        ("doc-kept", "upsert"), ("doc-removed", "remove"),
    ]
    assert _upsert_rows(state, namespace, "doc-gone") == [(False, True)]
    assert _page_outcomes(state, namespace, "doc-gone") == [("superseded", replacement)]
    assert state.work_is_current(work["doc-gone"]) is False
    assert state.work_membership_current(work["doc-gone"]) is False
    assert state.claimed_elsewhere("connection", 4, peer, "doc-gone") is False
    # The upsert for the document it holds stays owed, and the replacement — not the retired
    # snapshot — now answers for it.
    assert state.work_snapshot_id(work["doc-kept"]) == replacement
    assert state.work_membership_current(work["doc-kept"]) is True
    assert _upsert_rows(state, namespace, "doc-kept") == [(False, False)]
    assert _page_outcomes(state, namespace, "doc-kept") == [("pending", None)]
    assert state.claimed_elsewhere("connection", 4, peer, "doc-kept") is True
    # The removal and its barrier stand.
    assert state.work_is_current(work["doc-removed"]) is True
    assert state.removal_barrier(work["doc-removed"], other) == "standing"
    # The other connection's upsert and claim for the same document are untouched.
    assert state.pending_count(theirs, 4) == 1
    assert state.work_membership_current(their_work) is True
    assert _upsert_rows(state, theirs, "doc-gone") == [(False, False)]
    assert state.claimed_elsewhere("other-connection", 4, peer, "doc-gone") is True
    state.close()


@pytest.mark.asyncio
async def test_in_flight_upsert_is_not_pushed_when_its_snapshot_is_replaced_without_it_during_extraction(
    tmp_path,
):
    state = StateStore(str(tmp_path / "in-flight-publication.sqlite"))
    progress = state.begin_generation(
        StreamKey("team", "connection", "account"), 9, start_token="start",
    )
    roots = [("folder", "folder", "my-drive", True)]
    active = state.begin_selection_snapshot(progress.namespace, 9, roots)
    state.materialize_page(
        progress.namespace, 9, "baseline:folder", "baseline", None, None, None,
        [("doc", "upsert", {"file_id": "doc"})], snapshot_id=active,
        membership_additions=[("doc", "folder", "my-drive", "folder")],
        traversal_completion=("folder", "folder", None),
    )
    state.publish_selection_snapshot(progress.namespace, 9, active)

    class Source:
        def _metadata(self, file_id):
            # Readable, and under a folder the snapshot about to be replaced traversed.
            return {"id": file_id, "mimeType": _DOC_MIME, "parents": ["folder"]}

        def _raw_doc(self, meta):
            # While the body is extracted, a replacement is published without the document.
            replacement = state.restart_selection_snapshot(
                progress.namespace, 9, roots, start_token="fresh",
            )
            state.complete_traversal(
                progress.namespace, 9, "folder", "folder", None, snapshot_id=replacement,
            )
            state.publish_selection_snapshot(progress.namespace, 9, replacement)
            return RawDoc(source="gdrive", external_id=meta["id"], body="stale")

    client = _RecordingBrain()
    summary = IngestSummary("docs", failure_categories={})
    await _drain_pending(
        client, GdriveExecution("connection", 9, 1, "owner", "later", "scope", {}),
        Source(), Connection("docs", "gdrive"), state, progress.namespace, 9, summary, 1,
    )

    assert client.pushed == [] and summary.failed == 0
    assert state.pending_count(progress.namespace, 9) == 0
    assert _upsert_rows(state, progress.namespace, "doc") == [(False, True)]
    state.close()


# ---------------------------------------------------------------------------------------------
# A restart committed locally survives the loss of the checkpoint that reports it
# ---------------------------------------------------------------------------------------------
#
# Spec. A restart under a fresh token is one SQLite transaction, and the brain is told of it
# afterwards. A process that dies between the two leaves the restart in local state and the
# brain's record as it was. The next run neither captures another token nor restarts again: it
# enumerates the build that restart began, under the token captured for it, never reads the
# cursor the brain still holds, and reconciles only after a drain from that token.


@pytest.mark.parametrize("recovery", ["invalid-cursor", "lost-tokens"])
@pytest.mark.asyncio
async def test_restart_committed_locally_whose_brain_checkpoint_is_lost_is_carried_through_by_the_next_run(
    tmp_path, monkeypatch, recovery,
):
    world = _DriveWorld(folder_ids=["folder-r"]).install(monkeypatch)
    world.put("folder-r", drive="shared-a", folder=True)
    world.put("doc-1", drive="shared-a", parent="folder-r")
    path = str(tmp_path / f"restart-checkpoint-lost-{recovery}.sqlite")
    state = StateStore(path)
    namespace = world.namespace("shared-a")
    assert (await world.run(state)).authoritative_complete is True
    before = state.get_progress(namespace)

    # A document enters the folder. Its change is before the token the recovery captures, so
    # only a listing under that token can find it.
    world.put("doc-late", drive="shared-a", parent="folder-r")
    world.logs["shared-a"].append({"fileId": "doc-late", "file": dict(world.files["doc-late"])})
    fresh = "shared-a@1"
    if recovery == "invalid-cursor":
        world.cursor_errors["shared-a"] = ProviderCursorInvalid("expired")
    else:
        _lose_stream_tokens(world, state, namespace)
    # The restart is committed to SQLite, and the process dies before the brain hears of it.
    world.checkpoint_faults.append(
        lambda progress: RuntimeError("process killed")
        if progress.get("baseline_start_token") == fresh else None
    )
    with pytest.raises(RuntimeError, match="process killed"):
        await world.run(state)
    world.cursor_errors.clear()
    state.close()

    state = StateStore(path)
    local = state.get_progress(namespace)
    assert local.active_snapshot == before.active_snapshot
    assert local.building_snapshot not in {None, before.active_snapshot}
    assert (local.baseline_start_token, local.page_token) == (fresh, None)
    assert local.drain_observation > before.drain_observation
    assert local.terminal_drain_acknowledged is False
    assert state.membership_ids(namespace, 9) == ["doc-1"]
    # The brain's record is the one from before the restart.
    assert world.stream("shared-a")["building_snapshot"] is None
    assert world.stream("shared-a")["baseline_start_token"] != fresh
    assert world.reconciled == [["doc-1"]]

    world.calls.clear()
    world.pushed.clear()
    converged = await world.run(state)

    assert ("start", "shared-a") not in world.calls
    assert ("list", "shared-a", "folder-r") in world.calls
    assert [call for call in world.calls if call[0] == "changes"] == [("changes", "shared-a", fresh)]
    progress = state.get_progress(namespace)
    assert progress.active_snapshot == local.building_snapshot and progress.building_snapshot is None
    assert state.membership_ids(namespace, 9) == ["doc-1", "doc-late"]
    assert sorted(world.pushed) == ["doc-1", "doc-late"]
    assert world.stream("shared-a")["baseline_start_token"] == fresh
    assert converged.failed == 0 and converged.authoritative_complete is True
    assert converged.backlog == 0
    assert world.reconciled == [["doc-1"], ["doc-1", "doc-late"]] and world.removed == []
    assert world.stream("shared-a")["phase"] == "current"
    state.close()
