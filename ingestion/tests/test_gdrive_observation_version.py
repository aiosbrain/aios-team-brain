"""AIO-1167 R95 — one CERTIFIED provider observation per Google Drive document read.

A document's body and its mutable metadata are accepted together only when the same provider file id
and Drive ``version`` bracket the content read (metadata before, metadata after). The version is an
opaque decimal string: requested in every metadata projection, carried without numeric conversion, and
compared exactly whatever its length. A read the document changed under is re-read from the newer
observation, boundedly; a mixed observation never becomes a ``RawDoc``.
"""

from __future__ import annotations

import re

import pytest

from aios_ingest.gdrive_sync import read_change_page
from aios_ingest.normalize import NormalizeConfig, normalize
from aios_ingest.sources.gdrive import (
    GOOGLE_DOC_MIME,
    CertifiedDocument,
    GoogleDriveSource,
    IncompleteExtractionError,
    UnstableObservationError,
    compare_drive_versions,
    drive_version,
)

FILE_ID = "doc-r95"


def _document(text: str) -> dict:
    return {
        "title": "Doc",
        "tabs": [{
            "tabProperties": {"tabId": "t.0", "title": "Main", "index": 0},
            "documentTab": {"body": {"content": [
                {"paragraph": {"elements": [{"textRun": {"content": text + "\n"}}]}},
            ]}},
        }],
    }


class _Request:
    def __init__(self, produce):
        self._produce = produce

    def execute(self):
        return self._produce()


class _Documents:
    def __init__(self, provider: "Provider"):
        self._provider = provider

    def get(self, **kwargs):
        return _Request(lambda: self._provider.read_content(kwargs["documentId"]))


class _Docs:
    def __init__(self, provider: "Provider"):
        self._provider = provider

    def documents(self):
        return _Documents(self._provider)


class Provider:
    """One Drive file whose SERVER-SIDE state (version, name, text, trash) can change between calls."""

    def __init__(self, states: list[dict]):
        self.states = states
        self.index = 0
        self.calls: list[str] = []
        # Run after a content read returns: the change lands between the content and the next metadata.
        self.after_content = None

    def state(self) -> dict:
        return self.states[self.index]

    def metadata(self, file_id: str) -> dict:
        self.calls.append("metadata")
        state = self.state()
        if "meta" in state:
            return dict(state["meta"])  # the provider's exact projection, omissions included
        meta = {
            "id": state.get("id", file_id), "name": state["name"], "mimeType": GOOGLE_DOC_MIME,
            "modifiedTime": state["modified"], "trashed": bool(state.get("trashed")),
        }
        if "version" in state:
            meta["version"] = state["version"]
        return meta

    def read_content(self, _file_id: str) -> dict:
        self.calls.append("content")
        document = _document(self.state()["text"])
        if self.after_content is not None:
            self.after_content(self)
        return document

    def revisions(self, _file_id: str) -> list | None:
        self.calls.append("revisions")
        return self.state().get("revisions", [])


def _source(provider: Provider) -> GoogleDriveSource:
    return GoogleDriveSource(
        file_ids=[FILE_ID], api_mode="docs", docs_service=_Docs(provider),
        metadata_loader=provider.metadata, revisions_loader=provider.revisions,
    )


def _state(version: str | None, name: str, text: str, minute: int = 0, **extra) -> dict:
    state = {"name": name, "text": text, "modified": f"2026-11-06T00:{minute:02d}:00.000Z", **extra}
    if version is not None:
        state["version"] = version
    return state


def _advance_once(provider: Provider) -> None:
    provider.index += 1
    provider.after_content = None


def test_a_stable_read_is_certified_with_its_version_and_post_read_metadata():
    provider = Provider([_state("7", "Stable title", "stable body")])
    source = _source(provider)
    doc = source._raw_doc(provider.metadata(FILE_ID))
    provider.calls.remove("metadata")  # the caller's opening read
    assert doc.extra_frontmatter["gdrive_version"] == "7"
    assert doc.title == "Stable title" and "stable body" in doc.body
    # Metadata is read again AFTER the content and the revision history: that read closes the bracket.
    assert provider.calls == ["content", "revisions", "metadata"]


def test_a_change_during_extraction_is_reread_from_the_newer_observation():
    provider = Provider([
        _state("5", "Old title T1", "T1 older body"),
        _state("6", "New title T2", "T2 newer body", minute=1),
    ])
    provider.after_content = _advance_once  # T1's content is read, then the file changes to T2
    doc = _source(provider)._raw_doc(provider.metadata(FILE_ID))
    assert doc.extra_frontmatter["gdrive_version"] == "6"
    assert doc.title == "New title T2"
    assert "T2 newer body" in doc.body and "T1 older body" not in doc.body
    assert doc.source_ts == "2026-11-06T00:01:00.000Z"
    # Two content reads: the first, mixed, observation was discarded.
    assert provider.calls.count("content") == 2


def test_a_document_that_keeps_changing_never_reaches_the_sink():
    provider = Provider([_state(str(n), f"title {n}", f"body {n}", minute=n) for n in range(1, 10)])

    def keep_changing(p: Provider) -> None:
        p.index += 1

    provider.after_content = keep_changing
    with pytest.raises(UnstableObservationError):
        _source(provider)._raw_doc(provider.metadata(FILE_ID))
    # A subclass of the incomplete-extraction failure: the coordinator keeps the older body and retries.
    assert issubclass(UnstableObservationError, IncompleteExtractionError)
    assert provider.calls.count("content") == 3


def test_a_post_read_without_a_version_is_never_certified():
    provider = Provider([_state("4", "Has version", "body"), _state(None, "Lost version", "body")])
    provider.after_content = _advance_once
    with pytest.raises(UnstableObservationError):
        _source(provider)._raw_doc(provider.metadata(FILE_ID))


def test_a_document_trashed_during_the_read_is_not_accepted():
    provider = Provider([_state("4", "Live", "body"), _state("5", "Live", "body", trashed=True)])
    provider.after_content = _advance_once
    with pytest.raises(IncompleteExtractionError):
        _source(provider)._raw_doc(provider.metadata(FILE_ID))


def test_another_file_read_back_is_not_a_bracket():
    provider = Provider([_state("4", "Live", "body"), _state("4", "Live", "body", id="someone-else")])
    provider.after_content = _advance_once
    with pytest.raises(UnstableObservationError):
        _source(provider)._raw_doc(provider.metadata(FILE_ID))


def test_a_versionless_read_is_uncertified_and_unchanged_in_shape():
    provider = Provider([_state(None, "Legacy", "legacy body")])
    doc = _source(provider)._raw_doc(provider.metadata(FILE_ID))
    provider.calls.remove("metadata")
    assert "gdrive_version" not in doc.extra_frontmatter
    # No bracket is possible without a version: one content read, as before this contract.
    assert provider.calls == ["content", "revisions"]


def test_a_large_version_travels_as_the_exact_decimal_string():
    huge = "184467440737095516160000000000123"
    provider = Provider([_state("000" + huge, "Huge", "body")])
    doc = _source(provider)._raw_doc(provider.metadata(FILE_ID))
    assert doc.extra_frontmatter["gdrive_version"] == huge
    item = normalize(doc, NormalizeConfig())
    assert item.frontmatter["gdrive_version"] == huge
    assert isinstance(item.frontmatter["gdrive_version"], str)


@pytest.mark.parametrize("raw, canonical", [
    ("0007", "7"), ("0", "0"), ("000", "0"), ("9007199254740993", "9007199254740993"),
    ("184467440737095516160000", "184467440737095516160000"),
])
def test_drive_version_canonicalizes_valid_tokens(raw, canonical):
    assert drive_version(raw) == canonical


@pytest.mark.parametrize("raw", ["", "-1", " 7", "7 ", "1e3", "7.0", "١٢", 7, True, None, ["7"]])
def test_drive_version_rejects_malformed_tokens(raw):
    assert drive_version(raw) is None


def test_compare_drive_versions_is_exact_past_float_precision():
    # 2^53 + 1 and 2^53 are EQUAL as floats; the string order tells them apart.
    assert float("9007199254740993") == float("9007199254740992")
    assert compare_drive_versions("9007199254740993", "9007199254740992") == 1
    assert compare_drive_versions("10", "9") == 1
    assert compare_drive_versions("9", "10") == -1
    assert compare_drive_versions("42", "42") == 0
    assert compare_drive_versions("184467440737095516160000", "99999999999999999999999") == 1


class _Capture:
    """A Drive double recording the projection every metadata/listing/change request asks for."""

    def __init__(self):
        self.fields: list[str] = []

    def files(self):
        return self

    def changes(self):
        return self

    def get(self, **kwargs):
        self.fields.append(kwargs["fields"])
        return _Request(lambda: {"id": kwargs["fileId"], "name": "n", "modifiedTime": "2026-11-06T00:00:00Z"})

    def list(self, **kwargs):
        self.fields.append(kwargs["fields"])
        return _Request(lambda: {"files": [], "changes": []})


def test_every_metadata_projection_requests_the_version():
    drive = _Capture()
    source = GoogleDriveSource(
        folder_ids=["folder"], api_mode="docs", drive_service=drive, docs_service=_Docs(Provider([])),
    )
    source._metadata(FILE_ID)
    list(source._selected_files())
    read_change_page(drive, "token")
    assert len(drive.fields) == 3
    for projection in drive.fields:
        assert re.search(r"[,(]version[,)]", projection), projection


# ── AIO-1167 R98: one complete metadata snapshot per certified version ─────────────────────────────

T1_FULL = {
    "id": FILE_ID, "name": "Plan T1", "mimeType": GOOGLE_DOC_MIME, "version": "5",
    "modifiedTime": "2026-11-01T09:00:00.000Z", "createdTime": "2026-10-01T00:00:00.000Z",
    "driveId": "drive-t1", "parents": ["folder-t1"], "webViewLink": "https://docs.example/t1",
    "owners": [{"permissionId": "owner-t1", "emailAddress": "owner@t1.example", "displayName": "Owner"}],
    "lastModifyingUser": {"permissionId": "editor-t1", "emailAddress": "editor@t1.example", "displayName": "Ed"},
}
# T2 is a COMPLETE projection that simply omits the optional fields (no drive, owners or editor).
T2_SPARSE = {
    "id": FILE_ID, "name": "Plan T2", "mimeType": GOOGLE_DOC_MIME, "version": "6",
    "modifiedTime": "2026-11-03T15:00:00.000Z", "parents": ["folder-t2"],
}


@pytest.mark.parametrize("history", [[], None], ids=["empty-history", "history-unavailable"])
def test_optional_fields_t2_omits_never_survive_from_t1(history):
    provider = Provider([
        {"meta": T1_FULL, "text": "T1 older body", "revisions": history},
        {"meta": T2_SPARSE, "text": "T2 newer body", "revisions": history},
    ])
    provider.after_content = _advance_once
    certified = _source(provider)._certified_raw_doc(provider.metadata(FILE_ID))
    assert isinstance(certified, CertifiedDocument)
    doc, meta = certified.doc, certified.metadata
    assert meta == T2_SPARSE, "the certified snapshot is T2's projection, nothing carried from T1"
    assert doc.extra_frontmatter["gdrive_version"] == "6"
    assert doc.extra_frontmatter["drive_id"] is None
    assert doc.extra_frontmatter["gdrive_source_identities"] == []
    assert doc.authors is None, "T1's last editor is not T2's author"
    # No contribution of T1's editor stamped with T2's time — with empty or unavailable history alike.
    assert doc.extra_frontmatter["contributions"] == []
    assert "editor-t1" not in repr(doc.extra_frontmatter) and "owner-t1" not in repr(doc.extra_frontmatter)
    assert doc.source_ts == "2026-11-03T15:00:00.000Z" and doc.title == "Plan T2"


def test_control_a_stable_observation_keeps_its_own_optional_fields():
    provider = Provider([{"meta": T1_FULL, "text": "stable body", "revisions": []}])
    certified = _source(provider)._certified_raw_doc(provider.metadata(FILE_ID))
    assert certified.metadata == T1_FULL
    assert certified.doc.extra_frontmatter["drive_id"] == "drive-t1"
    assert [a["external_id"] for a in certified.doc.authors] == ["permission:editor-t1"]
    # Its own editor and time: the latest-editor fallback of an empty history, not a borrowed one.
    assert certified.doc.extra_frontmatter["contributions"][0]["external_id"] == "permission:editor-t1"
    assert certified.doc.extra_frontmatter["contributions"][0]["at"] == "2026-11-01T09:00:00.000Z"


def test_control_a_stable_observation_without_optional_fields_is_certified():
    provider = Provider([{"meta": T2_SPARSE, "text": "sparse body"}])
    certified = _source(provider)._certified_raw_doc(provider.metadata(FILE_ID))
    assert certified.metadata == T2_SPARSE
    assert certified.doc.extra_frontmatter["gdrive_version"] == "6"
    assert certified.doc.extra_frontmatter["drive_id"] is None and certified.doc.authors is None


@pytest.mark.parametrize("missing", ["name", "modifiedTime"])
def test_a_snapshot_missing_a_required_certification_field_is_never_certified(missing):
    incomplete = {key: value for key, value in T1_FULL.items() if key != missing}
    provider = Provider([{"meta": T1_FULL, "text": "body"}, {"meta": incomplete, "text": "body"}])
    provider.after_content = _advance_once  # same version, but the closing read cannot label the body
    with pytest.raises(IncompleteExtractionError) as raised:
        _source(provider)._certified_raw_doc(provider.metadata(FILE_ID))
    assert missing in str(raised.value)


def test_a_versioned_supplemental_read_replaces_the_hint_it_supplements():
    # A change-page hint without a name: the supplemental read is a complete projection of its own.
    hint = {"id": FILE_ID, "driveId": "hint-drive", "owners": T1_FULL["owners"], "modifiedTime": "x"}
    provider = Provider([{"meta": T2_SPARSE, "text": "body"}])
    certified = _source(provider)._certified_raw_doc(hint)
    assert certified.metadata == T2_SPARSE
    assert certified.doc.extra_frontmatter["drive_id"] is None
    assert certified.doc.extra_frontmatter["gdrive_source_identities"] == []
    assert provider.calls == ["metadata", "content", "revisions", "metadata"]


def test_a_versionless_supplemental_read_keeps_the_legacy_merge():
    hint = {"id": FILE_ID, "driveId": "hint-drive"}
    legacy = {"id": FILE_ID, "name": "Legacy", "modifiedTime": "2026-11-01T00:00:00.000Z", "mimeType": GOOGLE_DOC_MIME}
    provider = Provider([{"meta": legacy, "text": "legacy body"}])
    certified = _source(provider)._certified_raw_doc(hint)
    assert certified.metadata == {**hint, **legacy}
    assert certified.doc.extra_frontmatter["drive_id"] == "hint-drive"
    assert "gdrive_version" not in certified.doc.extra_frontmatter
