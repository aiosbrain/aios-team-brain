"""Docs content the body traversal used to miss or misstate (AIO-1167 R44 F2, C9, S6a).

F2 — headers and footers. `DocumentTab.headers`/`footers` are segments OUTSIDE the body. Their
readable text is rendered with tab and segment-id provenance, once per segment (however many
sections reuse it), on root and child tabs and on the legacy root path. A malformed segment map or
segment is blocking, so the source raises `IncompleteExtractionError` and the adapter keeps the prior
complete document instead of overwriting it. The character limit still applies.

C9 — chips. A rich-link chip is a readable link: its returned title/URI render as a Markdown link
(never fetched); a chip without a returned URI is missing required content (blocking); a non-http(s)
target keeps its title and is disclosed. Person/date chips render their returned text or are
disclosed specifically — never silently dropped.

S6a — suggestions. Documents are requested as PREVIEW_WITHOUT_SUGGESTIONS (current content, without
proposed edits). Should a suggestion still arrive, a proposed insertion is omitted and a proposed
deletion is kept, so view-only and edit-capable credentials yield the same intended text.
"""

from __future__ import annotations

import pytest

from aios_ingest.sources.gdrive import GoogleDriveSource, IncompleteExtractionError
from aios_ingest.sources.gdrive_docs import extract_google_doc
from test_gdrive_upgrade import _Docs, _Drive, _paragraph


def _tab(tab_id, body, **segments):
    return {"tabProperties": {"tabId": tab_id, "title": tab_id.title()},
            "documentTab": {"body": {"content": body}, **segments}}


def _segments(**texts):
    return {sid: {"content": [_paragraph(f"{text}\n")]} for sid, text in texts.items()}


def _codes(extraction):
    return {(issue.code, issue.blocking) for issue in extraction.issues}


# --- F2 -------------------------------------------------------------------------------------------

def test_header_and_footer_text_is_rendered_once_with_segment_provenance_on_root_and_child_tabs():
    child = _tab("child", [_paragraph("child body\n")], headers=_segments(**{"h.child": "CHILD-HEADER-MARKER"}))
    root = _tab("root", [_paragraph("root body\n")],
                headers=_segments(**{"h.1": "ROOT-HEADER-MARKER"}),
                footers=_segments(**{"f.1": "ROOT-FOOTER-MARKER"}))
    root["childTabs"] = [child]
    extraction = extract_google_doc({"title": "Doc", "tabs": [root]})

    assert extraction.complete
    for marker in ("ROOT-HEADER-MARKER", "ROOT-FOOTER-MARKER", "CHILD-HEADER-MARKER"):
        assert extraction.text.count(marker) == 1
    root_entry, child_entry = extraction.tabs
    assert [span[0] for span in root_entry["headers"]] == ["h.1"]
    assert [span[0] for span in root_entry["footers"]] == ["f.1"]
    assert [span[0] for span in child_entry["headers"]] == ["h.child"]
    (sid, start, end) = root_entry["headers"][0]
    assert "ROOT-HEADER-MARKER" in extraction.text[start:end]
    assert root_entry["text_start"] <= start < end <= root_entry["text_end"]


def test_a_header_referenced_by_several_sections_is_still_one_segment():
    body = [{"sectionBreak": {"sectionStyle": {"defaultHeaderId": "h.1"}}}, _paragraph("one\n"),
            {"sectionBreak": {"sectionStyle": {"defaultHeaderId": "h.1"}}}, _paragraph("two\n")]
    extraction = extract_google_doc({"title": "Doc", "tabs": [_tab("root", body, headers=_segments(**{"h.1": "SHARED-HEADER"}))]})
    assert extraction.complete and extraction.text.count("SHARED-HEADER") == 1


def test_the_legacy_root_path_renders_headers_and_footers_too():
    document = {"title": "Legacy", "body": {"content": [_paragraph("legacy body\n")]},
                "headers": _segments(**{"h": "LEGACY-HEADER"}), "footers": _segments(**{"f": "LEGACY-FOOTER"})}
    extraction = extract_google_doc(document)
    assert "LEGACY-HEADER" in extraction.text and "LEGACY-FOOTER" in extraction.text
    assert ("legacy_root_body", False) in _codes(extraction)


@pytest.mark.parametrize(
    "segments, code",
    [
        ({"headers": ["not", "a", "map"]}, "malformed_headers"),
        ({"footers": "nope"}, "malformed_footers"),
        ({"headers": {"h.1": "not an object"}}, "missing_content"),
        ({"footers": {"f.1": {"content": None}}}, "missing_content"),
        ({"headers": {"h.1": {"content": [42]}}}, "malformed_block"),
    ],
)
def test_a_malformed_segment_is_blocking(segments, code):
    extraction = extract_google_doc({"title": "Doc", "tabs": [_tab("root", [_paragraph("body\n")], **segments)]})
    assert not extraction.complete
    assert (code, True) in _codes(extraction)


def test_the_character_limit_applies_to_segments():
    extraction = extract_google_doc(
        {"title": "Doc", "tabs": [_tab("root", [_paragraph("body\n")], footers=_segments(f="x" * 500))]},
        max_chars=200,
    )
    assert not extraction.complete and ("limit_exceeded", True) in _codes(extraction)


def _source(document):
    drive = _Drive(pages=[], metadata={"doc1": {
        "id": "doc1", "name": "Doc", "mimeType": "application/vnd.google-apps.document",
        "modifiedTime": "2026-09-01T01:02:03Z",
    }})
    docs = _Docs({"doc1": document})
    return GoogleDriveSource(file_ids=["doc1"], api_mode="docs", _drive_service=drive, _docs_service=docs), docs


def test_through_the_adapter_a_malformed_footer_is_incomplete_and_never_a_document():
    source, _ = _source({"title": "Doc", "tabs": [_tab("root", [_paragraph("known complete body\n")], footers="nope")]})
    with pytest.raises(IncompleteExtractionError, match="malformed_footers"):
        list(source.fetch())


# --- C9 -------------------------------------------------------------------------------------------

def _inline_doc(*inlines):
    return {"title": "Doc", "tabs": [_tab("root", [{"paragraph": {"elements": list(inlines) + [{"textRun": {"content": "\n"}}]}}])]}


def test_a_rich_link_chip_renders_its_returned_title_and_uri():
    extraction = extract_google_doc(_inline_doc(
        {"richLink": {"richLinkProperties": {"title": "Roadmap", "uri": "https://docs.google.com/doc/r"}}},
    ))
    assert extraction.complete and "[Roadmap](https://docs.google.com/doc/r)" in extraction.text


def test_a_rich_link_without_a_title_still_renders_its_uri():
    extraction = extract_google_doc(_inline_doc({"richLink": {"richLinkProperties": {"uri": "https://x.example/y"}}}))
    assert extraction.complete and "[https://x.example/y](https://x.example/y)" in extraction.text


@pytest.mark.parametrize("chip", [{}, {"richLinkProperties": None}, {"richLinkProperties": {"title": "No URI"}},
                                  {"richLinkProperties": {"uri": "  "}}, "not an object"])
def test_a_rich_link_without_a_returned_uri_is_missing_required_content(chip):
    extraction = extract_google_doc(_inline_doc({"richLink": chip}))
    assert not extraction.complete and ("malformed_rich_link", True) in _codes(extraction)


def test_a_non_http_rich_link_keeps_its_title_and_is_disclosed():
    extraction = extract_google_doc(_inline_doc(
        {"richLink": {"richLinkProperties": {"title": "Run me", "uri": "javascript:alert(1)"}}},
    ))
    assert extraction.complete
    assert "Run me" in extraction.text and "javascript:" not in extraction.text
    assert ("rich_link_scheme_omitted", False) in _codes(extraction)


@pytest.mark.parametrize(
    "inline, rendered",
    [
        ({"person": {"personProperties": {"name": "Ada Lovelace", "email": "ada@example.com"}}}, "Ada Lovelace <ada@example.com>"),
        ({"person": {"personProperties": {"email": "ada@example.com"}}}, "ada@example.com"),
        ({"dateElement": {"dateElementProperties": {"displayText": "Oct 27, 2026"}}}, "Oct 27, 2026"),
    ],
)
def test_person_and_date_chips_render_their_returned_text(inline, rendered):
    extraction = extract_google_doc(_inline_doc(inline))
    assert extraction.complete and rendered in extraction.text


@pytest.mark.parametrize("inline, code", [
    ({"person": {}}, "unsupported_person_chip"),
    ({"dateElement": {"dateElementProperties": {"timestamp": "2026-10-27T00:00:00Z"}}}, "unsupported_date_chip"),
])
def test_a_chip_without_readable_text_is_disclosed_specifically(inline, code):
    extraction = extract_google_doc(_inline_doc(inline))
    assert extraction.complete and (code, False) in _codes(extraction)


# --- S6a ------------------------------------------------------------------------------------------

def test_documents_are_requested_without_suggestions():
    source, docs = _source({"title": "Doc", "tabs": [_tab("root", [_paragraph("body\n")])]})
    list(source.fetch())
    assert docs.api.calls and all(call["suggestionsViewMode"] == "PREVIEW_WITHOUT_SUGGESTIONS" for call in docs.api.calls)


def test_a_returned_suggestion_never_blends_into_current_content():
    def run(content, **suggestion):
        return {"textRun": {"content": content, **suggestion}}

    with_suggestions = extract_google_doc(_inline_doc(
        run("Kept "), run("PROPOSED-INSERT ", suggestedInsertionIds=["s1"]),
        run("still-current ", suggestedDeletionIds=["s2"]), run("end"),
    ))
    without = extract_google_doc(_inline_doc(run("Kept "), run("still-current "), run("end")))
    assert with_suggestions.complete
    assert "PROPOSED-INSERT" not in with_suggestions.text
    assert with_suggestions.text == without.text
    assert {("suggested_insertion_omitted", False), ("suggested_deletion_retained", False)} <= _codes(with_suggestions)
