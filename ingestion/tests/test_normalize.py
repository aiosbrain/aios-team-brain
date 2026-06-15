from aios_ingest.normalize import NormalizeConfig, RawDoc, normalize


def _doc(**kw) -> RawDoc:
    base = dict(source="github", external_id="run-llama/llama_index/docs/x.md", body="hello")
    base.update(kw)
    return RawDoc(**base)


def test_path_is_stable_and_md_suffixed():
    item = normalize(_doc(), NormalizeConfig())
    assert item.path == "github/run-llama/llama_index/docs/x.md"


def test_path_slugifies_unsafe_chars_and_adds_suffix():
    item = normalize(_doc(source="slack", external_id="C123/Some Thread!! 99"), NormalizeConfig())
    assert item.path == "slack/c123/some-thread-99.md"


def test_path_capped_at_500():
    item = normalize(_doc(external_id="a/" * 400), NormalizeConfig())
    assert len(item.path) <= 500


def test_kind_defaults_by_source():
    assert normalize(_doc(source="slack"), NormalizeConfig()).kind == "transcript"
    assert normalize(_doc(source="gdrive"), NormalizeConfig()).kind == "deliverable"


def test_doc_kind_overrides_default():
    assert normalize(_doc(source="slack", kind="deliverable"), NormalizeConfig()).kind == "deliverable"


def test_access_and_project_resolution():
    cfg = NormalizeConfig(default_project="handbook", default_access="external", actor="gh-sync")
    item = normalize(_doc(), cfg)
    assert item.project == "handbook"
    assert item.access == "external"
    assert item.actor == "gh-sync"


def test_actor_defaults_to_source_sync():
    assert normalize(_doc(source="notion"), NormalizeConfig()).actor == "notion-sync"


def test_provenance_frontmatter_and_title_prepend():
    item = normalize(
        _doc(title="Onboarding", url="https://x/y", author="alex", source_ts="2026-06-14T00:00:00Z"),
        NormalizeConfig(),
    )
    fm = item.frontmatter
    assert fm["source"] == "github"
    assert fm["source_id"] == "run-llama/llama_index/docs/x.md"
    assert fm["source_url"] == "https://x/y"
    assert fm["author"] == "alex"
    assert fm["source_ts"] == "2026-06-14T00:00:00Z"
    assert item.body.startswith("# Onboarding\n\n")


def test_same_doc_hashes_identically_idempotent():
    a = normalize(_doc(), NormalizeConfig())
    b = normalize(_doc(), NormalizeConfig())
    assert a.content_sha256 == b.content_sha256
