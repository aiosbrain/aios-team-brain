"""Binary document -> text extraction via Unstructured (Apache-2.0).

Drive/Confluence/SharePoint files are often PDF/docx/pptx; Unstructured turns them into
clean text suitable for the item ``body``. Lazy-imported so the core installs without it.
"""

from __future__ import annotations

from ..sources.base import MissingExtraError


def extract_text(file_path: str) -> str:
    """Return concatenated text from a document file. Raises MissingExtraError if the
    'docs' extra (Unstructured) isn't installed."""
    try:
        from unstructured.partition.auto import partition
    except ImportError as e:
        raise MissingExtraError("docs", "unstructured") from e
    elements = partition(filename=file_path)
    return "\n\n".join(str(el) for el in elements if str(el).strip())
