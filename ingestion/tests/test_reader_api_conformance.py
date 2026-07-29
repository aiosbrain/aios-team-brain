"""Conformance: the reader APIs our adapters call must exist in the INSTALLED libraries.

`test_reader_adapters.py` drives `fetch()` through hand-written fakes, which proves our code
is right given a believed reader shape. This tier proves the belief — no account, no network,
just the real classes' signatures.

It is the tier that catches the failure mode that actually bites on a first run: a kwarg the
library does not take, or one it renamed in a minor bump. It caught a live one when it was
written — `NotionPageReader.load_data` has no `database_id`, only `database_ids` (a list), so
every Notion *database* connection raised TypeError on its first tick.

What it still cannot cover: authentication, scopes, pagination and the live API's metadata
keys. Those need a real account; `docs/TODO.md` records them as open rather than implying this
tier closed them.

Requires the reader extras (`.[notion,gdrive,confluence]`), which CI installs. Locally without
them the checks skip — so `test_conformance_is_not_silently_skipped_in_ci` fails the build if
CI ever loses the extras and these vanish into a green run.
"""

from __future__ import annotations

import inspect
import os
import re

import pytest

from _reader_fakes import ALL_FAKES

# Every reader kwarg our adapters actually pass, with the call site that passes it. Kept
# explicit rather than derived: a check that reads the same source it is checking cannot fail.
ADAPTER_CALLS = [
    # aios_ingest/sources/notion.py
    ("llama_index.readers.notion", "NotionPageReader", "__init__", ["integration_token"]),
    ("llama_index.readers.notion", "NotionPageReader", "load_data", ["page_ids", "database_ids"]),
    # aios_ingest/sources/gdrive.py
    ("llama_index.readers.google", "GoogleDriveReader", "__init__", ["service_account_key_path"]),
    ("llama_index.readers.google", "GoogleDriveReader", "load_data", ["folder_id", "file_ids"]),
    # aios_ingest/sources/confluence.py
    ("llama_index.readers.confluence", "ConfluenceReader", "__init__", ["base_url"]),
    ("llama_index.readers.confluence", "ConfluenceReader", "load_data", ["space_key", "page_ids"]),
]

# The reader-extra → import module map, so a skip names the extra an operator would install.
EXTRA_FOR_MODULE = {
    "llama_index.readers.notion": "notion",
    "llama_index.readers.google": "gdrive",
    "llama_index.readers.confluence": "confluence",
}


def _reader_class(module: str, cls: str):
    mod = pytest.importorskip(
        module, reason=f"needs the '{EXTRA_FOR_MODULE[module]}' extra (CI installs it)"
    )
    return getattr(mod, cls)


def _params(func) -> tuple[set[str], bool]:
    """(parameter names, accepts **kwargs). A `**kwargs` reader — GoogleDriveReader has one —
    would swallow any name, so a bind-based check passes vacuously there; only an explicit
    name comparison is non-vacuous."""
    sig = inspect.signature(func)
    names = {
        p.name
        for p in sig.parameters.values()
        if p.kind in (p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)
    }
    var_kw = any(p.kind is p.VAR_KEYWORD for p in sig.parameters.values())
    return names, var_kw


@pytest.mark.parametrize(
    ("module", "cls", "method", "kwargs"),
    ADAPTER_CALLS,
    ids=[f"{c}.{m}" for _, c, m, _ in ADAPTER_CALLS],
)
def test_adapter_kwargs_exist_on_the_real_reader(module, cls, method, kwargs):
    reader = _reader_class(module, cls)
    names, _ = _params(getattr(reader, method))
    missing = [k for k in kwargs if k not in names]
    assert not missing, (
        f"{cls}.{method} does not accept {missing} — the adapter passes it, so this connection "
        f"raises TypeError on its first run. Real parameters: {sorted(names)}"
    )


@pytest.mark.parametrize("fake", ALL_FAKES, ids=[f.__name__ for f in ALL_FAKES])
def test_the_fakes_are_not_a_lie(fake):
    """Every parameter a fake accepts must exist on the real class.

    Without this, the adapter tier is only as true as a hand-copied signature — and a fake that
    accepts a kwarg the library rejects grants exactly the false confidence this whole PR exists
    to remove. A rename in a minor bump fails HERE, naming `_reader_fakes.py`.
    """
    module, cls = fake.real
    real = _reader_class(module, cls)
    for method in ("__init__", "load_data"):
        fake_names, fake_var_kw = _params(getattr(fake, method))
        # A real `**kwargs` (GoogleDriveReader.__init__ has one) can only make this check
        # weaker, never wrong: it would let a bad name through here and fail on the live call
        # instead. A `**kwargs` on the FAKE is fatal, though — it accepts everything.
        real_names, _ = _params(getattr(real, method))
        assert not fake_var_kw, f"{fake.__name__}.{method} takes **kwargs — it would accept anything"
        extra = fake_names - real_names - {"self"}
        assert not extra, (
            f"{fake.__name__}.{method} accepts {sorted(extra)}, which {cls}.{method} does not. "
            f"Update _reader_fakes.py to the real signature: {sorted(real_names - {'self'})}"
        )


def test_confluence_credentials_are_read_the_way_the_docs_claim():
    """The adapter passes only `base_url` and lets the reader read credentials from the
    environment. That contract is what the README documents to operators, and it was WRONG once
    already (it told people to combine a token with a username, which the reader never accepts).
    So pin both halves: the env names, and the fact that token and user+password are mutually
    exclusive branches rather than a combination.
    """
    reader_cls = _reader_class("llama_index.readers.confluence", "ConfluenceReader")
    base_url = "https://example.atlassian.net/wiki"

    # Constructing the reader builds an HTTP client object; it makes no request, so this is
    # offline. Asserted behaviourally rather than by reading the library's source, so a
    # reformatting of the reader can't turn this red on an unrelated PR.
    with pytest.MonkeyPatch.context() as mp:
        for var in ("CONFLUENCE_API_TOKEN", "CONFLUENCE_USERNAME", "CONFLUENCE_PASSWORD"):
            mp.delenv(var, raising=False)
        with pytest.raises(ValueError):
            reader_cls(base_url=base_url)  # no credential anywhere → refuses to construct

        mp.setenv("CONFLUENCE_API_TOKEN", "tok")
        assert reader_cls(base_url=base_url) is not None  # token ALONE is sufficient

    with pytest.MonkeyPatch.context() as mp:
        # All three, not just the token: a developer who actually uses Confluence would have
        # CONFLUENCE_PASSWORD set, and the reader would pair it with the fake username below —
        # constructing successfully and failing this test on their machine only.
        for var in ("CONFLUENCE_API_TOKEN", "CONFLUENCE_USERNAME", "CONFLUENCE_PASSWORD"):
            mp.delenv(var, raising=False)
        mp.setenv("CONFLUENCE_USERNAME", "ada@x.co")
        with pytest.raises(ValueError):
            reader_cls(base_url=base_url)  # a username WITHOUT a password is not a credential
        mp.setenv("CONFLUENCE_PASSWORD", "pw")
        assert reader_cls(base_url=base_url) is not None  # username + password is the other branch


def test_notion_reader_carries_no_timestamp_so_the_api_backfill_is_load_bearing():
    """`NotionSource` makes an extra API call per page purely to recover `last_edited_time`,
    because the reader's Document metadata has only `page_id`. If the reader ever starts
    emitting timestamps that call becomes removable — and if someone deletes it believing the
    reader supplies one, pages lose their work-time and drop off the timeline silently.
    """
    notion = pytest.importorskip("llama_index.readers.notion", reason="needs the 'notion' extra")
    # Whitespace-normalized so reformatting the library can't turn this red on an unrelated PR.
    load = re.sub(r"\s+", "", inspect.getsource(notion.NotionPageReader.load_data))
    assert 'extra_info={"page_id":page_id}' in load, (
        "NotionPageReader's document metadata changed — re-check whether "
        "NotionAuthorClient.page_edit_time is still needed for work-time"
    )


def test_conformance_is_not_silently_skipped_in_ci():
    """A skipped conformance tier is indistinguishable from a passing one in a green CI run.

    The reader extras are opt-in, so skipping is right on a laptop — but if the CI job ever
    drops them, every check above turns into a silent skip and this file stops guarding
    anything. In CI the extras are mandatory.
    """
    if not os.environ.get("CI"):
        pytest.skip("local run — the reader extras are optional off CI")
    import importlib

    for module, extra in EXTRA_FOR_MODULE.items():
        try:
            importlib.import_module(module)
        except ImportError as e:  # pragma: no cover - only on a broken CI install
            pytest.fail(
                f"CI must install the '{extra}' extra or the reader conformance checks skip "
                f"silently: {e}"
            )
