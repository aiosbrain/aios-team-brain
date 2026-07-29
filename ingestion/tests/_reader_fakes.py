"""Fake LlamaHub readers — the shape our adapters BELIEVE the real readers have.

Notion, Google Drive and Confluence can't be exercised against a live account in CI (no
org accounts, and credentials in CI is the wrong trade anyway). These fakes stand in for
the reader classes so `fetch()` itself is testable end to end:

    test_reader_adapters.py       drives fetch() through these — proves OUR code is right
                                  GIVEN this shape.
    test_reader_api_conformance.py checks these signatures against the INSTALLED reader
                                  classes — proves the shape is real.

The pairing is the point. A fake with `**kwargs`, or one hand-copied from a neighbouring
file, would accept a call the real library rejects and grant false confidence: exactly the
failure that shipped a `--source github` example that always failed. So every parameter
name below is mirrored from the real signature and pinned by the conformance tier; if a
reader renames a kwarg in a minor bump, that tier goes red and names this file.

Defaults are NOT mirrored (only names are compared) — the real
`NotionPageReader.load_data` has a mutable `page_ids=[]` default we don't want to copy.
"""

from __future__ import annotations

from typing import Any


class FakeDoc:
    """Stands in for `llama_index.core.schema.Document` — `.text` + `.metadata` is all
    `docs_to_raw` reads."""

    def __init__(self, text: str = "", metadata: dict[str, Any] | None = None):
        self.text = text
        self.metadata = metadata or {}


#: Sentinel for "the adapter did not pass this kwarg".
#:
#: `None` cannot serve here. A fake defaulting a parameter to `None` and forwarding it
#: unconditionally CANONICALIZES an omitted kwarg into an explicitly-passed `None`, so
#: "passed nothing" and "passed None" become indistinguishable — which made the Drive
#: service-account test green against the very bug it described. Only what the adapter
#: actually passed is recorded.
_UNSET: Any = object()


def _passed(**kwargs: Any) -> dict[str, Any]:
    return {k: v for k, v in kwargs.items() if v is not _UNSET}


class _RecordingReader:
    """Base: records how the adapter constructed it and how it called `load_data`."""

    #: (module, class) of the real reader this fake stands in for — read by the
    #: conformance tier, so adding a fake here automatically gets it checked.
    real: tuple[str, str] = ("", "")

    def __init__(self, **kwargs: Any):
        self.init_kwargs = kwargs
        self.load_kwargs: dict[str, Any] | None = None
        self.docs: list[FakeDoc] = []

    def _record(self, **kwargs: Any) -> list[FakeDoc]:
        # Only the kwargs actually passed — a default the adapter never set must not read
        # back as "the adapter chose this".
        self.load_kwargs = _passed(**kwargs)
        return self.docs


class FakeNotionPageReader(_RecordingReader):
    real = ("llama_index.readers.notion", "NotionPageReader")

    def __init__(self, integration_token: str | None = _UNSET):
        super().__init__(**_passed(integration_token=integration_token))

    def load_data(
        self,
        page_ids: list[str] | None = _UNSET,
        database_ids: list[str] | None = _UNSET,
        load_all_if_empty: bool = _UNSET,
    ) -> list[FakeDoc]:
        return self._record(
            page_ids=page_ids, database_ids=database_ids, load_all_if_empty=load_all_if_empty
        )


class FakeConfluenceReader(_RecordingReader):
    real = ("llama_index.readers.confluence", "ConfluenceReader")

    def __init__(
        self,
        base_url: str | None = _UNSET,
        api_token: str | None = _UNSET,
        user_name: str | None = _UNSET,
        password: str | None = _UNSET,
        cloud: bool = _UNSET,
    ):
        super().__init__(
            **_passed(
                base_url=base_url,
                api_token=api_token,
                user_name=user_name,
                password=password,
                cloud=cloud,
            )
        )

    def load_data(
        self,
        space_key: str | None = _UNSET,
        page_ids: list[str] | None = _UNSET,
        max_num_results: int | None = _UNSET,
    ) -> list[FakeDoc]:
        return self._record(
            space_key=space_key, page_ids=page_ids, max_num_results=max_num_results
        )


class FakeGoogleDriveReader(_RecordingReader):
    real = ("llama_index.readers.google", "GoogleDriveReader")

    def __init__(
        self,
        folder_id: str | None = _UNSET,
        file_ids: list[str] | None = _UNSET,
        service_account_key_path: str | None = _UNSET,
    ):
        super().__init__(
            **_passed(
                folder_id=folder_id,
                file_ids=file_ids,
                service_account_key_path=service_account_key_path,
            )
        )

    def load_data(
        self,
        folder_id: str | None = _UNSET,
        file_ids: list[str] | None = _UNSET,
        mime_types: list[str] | None = _UNSET,
    ) -> list[FakeDoc]:
        return self._record(folder_id=folder_id, file_ids=file_ids, mime_types=mime_types)


ALL_FAKES = (FakeNotionPageReader, FakeConfluenceReader, FakeGoogleDriveReader)


class ReaderSpy:
    """Handle on the reader the adapter built. `reader` is None until `fetch()` runs —
    the adapters construct lazily, and asserting on a reader that was never built would
    be a vacuous pass."""

    def __init__(self) -> None:
        self.reader: _RecordingReader | None = None

    @property
    def init_kwargs(self) -> dict[str, Any]:
        assert self.reader is not None, "adapter never constructed its reader"
        return self.reader.init_kwargs

    @property
    def load_kwargs(self) -> dict[str, Any]:
        assert self.reader is not None, "adapter never constructed its reader"
        assert self.reader.load_kwargs is not None, "adapter never called load_data"
        return self.reader.load_kwargs


def install(
    monkeypatch,
    adapter_module: str,
    fake_cls: type[_RecordingReader],
    docs: list[FakeDoc] | None = None,
) -> ReaderSpy:
    """Swap the adapter's `lazy_reader` for one that yields `fake_cls`.

    `lazy_reader` is the single seam every LlamaHub-backed adapter resolves its reader
    through, and each adapter imports it into its own namespace — so patching it there
    replaces the reader with no extra installed and no network call. The fake is
    constructed with the adapter's real kwargs, so an unexpected one raises TypeError
    exactly as the live reader would.
    """
    spy = ReaderSpy()

    def factory(**init: Any) -> _RecordingReader:
        reader = fake_cls(**init)
        reader.docs = list(docs or [])
        spy.reader = reader
        return reader

    def fake_lazy_reader(module: str, cls: str, *_a: Any, **_kw: Any):
        # The fake must stand in for the class the adapter ACTUALLY asked for. Ignoring these
        # arguments would let a typo'd module/class name — an AttributeError on the first live
        # run, exactly this PR's failure class — pass both tiers green, because the conformance
        # tier reads `fake_cls.real`, not the adapter's source.
        assert (module, cls) == fake_cls.real, (
            f"aios_ingest.sources.{adapter_module} resolves {(module, cls)}, but the fake stands "
            f"in for {fake_cls.real}. One of the two is wrong."
        )
        return factory

    monkeypatch.setattr(
        f"aios_ingest.sources.{adapter_module}.lazy_reader", fake_lazy_reader
    )
    return spy
