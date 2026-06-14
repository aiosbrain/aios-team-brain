import pytest
from pydantic import ValidationError

from aios_ingest.payload import ItemPayload, sha256_hex


def test_sha256_is_deterministic_lowercase_hex():
    h = sha256_hex("hello world")
    assert len(h) == 64
    assert h == sha256_hex("hello world")
    assert all(c in "0123456789abcdef" for c in h)


def test_build_computes_sha_from_body():
    item = ItemPayload.build(project="p", path="github/o/r/x.md", kind="deliverable", body="body")
    assert item.content_sha256 == sha256_hex("body")
    assert item.access == "team"  # default


def test_validator_rejects_bad_sha():
    with pytest.raises(ValidationError):
        ItemPayload(
            project="p", path="x.md", kind="deliverable",
            content_sha256="NOTHEX", access="team", body="b",
        )


def test_to_json_excludes_unused_rows():
    item = ItemPayload.build(project="p", path="x.md", kind="deliverable", body="b")
    assert "rows" not in item.to_json()
