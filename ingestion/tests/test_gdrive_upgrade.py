import asyncio
import dataclasses
import http.client
import json
import sqlite3
import time
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

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

    def __init__(self, *, file_ids=(), folder_ids=(), generation=9):
        self.config = {
            "authMode": "oauth", "authenticatedAccountId": "account",
            "fileIds": list(file_ids), "folderIds": list(folder_ids), "sharedDriveIds": [],
            "recursive": True, "selectionState": "selected",
        }
        self.generation = generation
        self.files, self.logs, self.calls = {}, {}, []
        self.unreadable, self.token_errors = {}, {}
        self.pushed, self.removed, self.reconciled = [], [], []
        self.progress, self.revision = {}, 0

    def put(self, file_id, *, drive, parent=None, folder=False):
        self.files[file_id] = {
            "id": file_id, "name": file_id, "mimeType": _FOLDER_MIME if folder else _DOC_MIME,
            "modifiedTime": "2026-09-22T00:00:00Z", "parents": [parent or drive],
            **({} if drive == "my-drive" else {"driveId": drive}),
        }

    def move(self, *file_ids, source, destination):
        """Move files between Shared Drives: gone from one drive's log, present in the other's."""
        for file_id in file_ids:
            self.files[file_id]["driveId"] = destination
            self.logs.setdefault(source, []).append({"fileId": file_id, "removed": True})
            self.logs.setdefault(destination, []).append(
                {"fileId": file_id, "file": dict(self.files[file_id])}
            )

    def namespace(self, drive_id):
        return StreamKey("team", _WORLD_INTEGRATION, "account", drive_id).namespace(self.generation)

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
                    return {"files": [
                        dict(meta) for meta in world.files.values()
                        if folder_id in meta["parents"] and meta.get("driveId", "my-drive") == drive_id
                    ]}
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
                world.revision += 1
                world.progress = json.loads(json.dumps(progress))
                return {"progress_revision": world.revision, "progress": progress}

            async def push(self, payload, *, execution):
                world.pushed.append(payload.frontmatter["source_id"])
                return IngestResult("created", "item", payload.path)

            async def reconcile_gdrive(self, execution, **kwargs):
                world.removed.extend(kwargs.get("removed_provider_ids") or [])
                if kwargs.get("complete_snapshot_ids") is not None:
                    world.reconciled.append(list(kwargs["complete_snapshot_ids"]))
                return {"items": 0}

            async def release_gdrive_execution(self, execution): pass

        monkeypatch.setattr("aios_ingest.gdrive_sync.BrainClient", Client)
        monkeypatch.setattr("aios_ingest.gdrive_sync.GoogleDriveSource", Source)
        return self

    async def run(self, state):
        return await run_gdrive_stream(
            BrainSettings("http://brain", "key", "team"),
            Connection("docs", "gdrive", options={"integration_id": _WORLD_INTEGRATION}), state,
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
