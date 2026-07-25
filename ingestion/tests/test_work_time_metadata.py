"""Spec: every sidecar document must reach the brain with a WORK-TIME (`source_ts`).

An item with no work-time resolves to null in the brain and is silently DROPPED from the timeline —
ingested, attributed, searchable, and invisible. That is exactly what happened to Notion / Google
Drive / Confluence / web docs: the metadata lookup used EXACT key names, but each LlamaHub reader
spells its timestamp differently (`last_edited_time`, `modifiedTime`, `modified at`), so the lookup
returned None and `source_ts` went empty. These tests pin the contract at the source.
"""

from aios_ingest.sources._llamahub import docs_to_raw


class FakeDoc:
    def __init__(self, text: str, metadata: dict):
        self.text = text
        self.metadata = metadata


def _one(meta: dict):
    return docs_to_raw([FakeDoc("body", meta)], source="notion", id_keys=("page_id",), fallback_prefix="notion")[0]


def test_snake_case_edit_time_is_work_time():
    assert _one({"page_id": "p1", "last_edited_time": "2026-06-01T10:00:00Z"}).source_ts == "2026-06-01T10:00:00Z"


def test_camel_case_spelling_resolves():
    # Google Drive-style spelling — an exact-match lookup missed this and dropped the doc.
    assert _one({"page_id": "p2", "modifiedTime": "2026-06-02T10:00:00Z"}).source_ts == "2026-06-02T10:00:00Z"


def test_space_separated_spelling_resolves():
    # Readers that emit human-ish keys ("modified at") must not silently yield an undated doc.
    assert _one({"page_id": "p3", "modified at": "2026-06-03T10:00:00Z"}).source_ts == "2026-06-03T10:00:00Z"


def test_edit_time_wins_over_creation_time():
    raw = _one({"page_id": "p4", "created_time": "2026-01-01T00:00:00Z", "last_edited_time": "2026-06-04T00:00:00Z"})
    assert raw.source_ts == "2026-06-04T00:00:00Z"


def test_creation_time_used_when_never_edited():
    assert _one({"page_id": "p5", "created_time": "2026-02-02T00:00:00Z"}).source_ts == "2026-02-02T00:00:00Z"


def test_no_timestamp_metadata_stays_honestly_undated():
    # We must NOT invent a time (that would date the doc to sync-time and resurface old content).
    assert _one({"page_id": "p6"}).source_ts is None


def test_document_without_a_stable_id_is_skipped_not_positionally_numbered():
    """`external_id` becomes the item's PATH, i.e. its identity. A positional `<prefix>-<i>` makes
    that identity depend on ITERATION ORDER: delete one document and every later one shifts down a
    slot, overwriting its neighbour's item — bodies swap and version history is mis-attributed
    across unrelated documents. Losing one document loudly beats corrupting the rest silently."""
    docs = [FakeDoc("a", {"page_id": "p1"}), FakeDoc("b", {}), FakeDoc("c", {"page_id": "p3"})]
    out = docs_to_raw(docs, source="notion", id_keys=("page_id",), fallback_prefix="notion")
    assert [r.external_id for r in out] == ["p1", "p3"]  # no "notion-1" invented
    assert [r.body for r in out] == ["a", "c"]  # and the survivors keep THEIR own bodies
