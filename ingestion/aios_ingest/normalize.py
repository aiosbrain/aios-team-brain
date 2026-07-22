"""RawDoc -> ItemPayload normalization: the "unit of knowledge" decisions.

Every source adapter emits a uniform :class:`RawDoc`; this module turns it into the
brain's ItemPayload — deciding path (stable + dedupe-safe), kind, access tier, and the
provenance frontmatter. Centralizing it here keeps the schema consistent across sources.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .payload import AccessTier, ItemKind, ItemPayload

# Source name -> default item kind. Conversations/notes are transcripts; documents are
# deliverables. Adapters may override per-document via RawDoc.kind.
DEFAULT_KIND_BY_SOURCE: dict[str, ItemKind] = {
    "slack": "transcript",
    "meeting": "transcript",
    "granola": "transcript",
    "gdrive": "deliverable",
    "notion": "deliverable",
    "confluence": "deliverable",
    "github": "deliverable",
    "web": "deliverable",
    "local": "deliverable",
    "radar": "artifact",
}

_SLUG_OK = re.compile(r"[^a-z0-9/_.-]+")


@dataclass
class RawDoc:
    """Uniform output of every source adapter, pre-normalization."""

    source: str  # "slack" | "gdrive" | "notion" | "github" | "confluence" | ...
    external_id: str  # stable id within the source (drives the dedupe-safe path)
    body: str  # extracted text/markdown (the indexed content)
    title: str | None = None
    url: str | None = None
    author: str | None = None
    # Structured author signal → the brain resolves each to a roster member at ingest
    # (lib/attribution/resolve-authors). Each entry: {role, email?, handle?, provider?, external_id?,
    # display_name?}. Preferred over the bare `author` string (which the brain only resolves as an
    # email); a document source that knows its authors (Notion created_by/last_edited_by, GDrive owner)
    # should populate this so its items attribute to real people, not the connector.
    authors: list[dict[str, str]] | None = None
    source_ts: str | None = None  # ISO timestamp of the source event, if known
    kind: ItemKind | None = None  # override DEFAULT_KIND_BY_SOURCE
    access: AccessTier | None = None  # override the connection default
    project: str | None = None  # override the connection default
    extra_frontmatter: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NormalizeConfig:
    """Per-connection normalization policy."""

    default_project: str | None = None  # falls back to the source name
    default_access: AccessTier = "team"
    actor: str | None = None  # provenance handle; falls back to "<source>-sync"


def _safe_path(source: str, external_id: str) -> str:
    """`<source>/<external-id>.md` — stable across re-reads so sha256 dedup works.
    External ids can contain arbitrary characters; collapse anything unsafe to '-'."""
    rel = external_id.strip().lstrip("/")
    rel = _SLUG_OK.sub("-", rel.lower())
    if not rel.endswith((".md", ".txt")):
        rel += ".md"
    path = f"{source}/{rel}"
    return path[:500]  # brain caps path at 500 chars


def normalize(doc: RawDoc, cfg: NormalizeConfig) -> ItemPayload:
    project = doc.project or cfg.default_project or doc.source
    kind = doc.kind or DEFAULT_KIND_BY_SOURCE.get(doc.source, "deliverable")
    access = doc.access or cfg.default_access
    actor = cfg.actor or f"{doc.source}-sync"

    frontmatter: dict[str, Any] = {
        "source": doc.source,
        "source_id": doc.external_id,
    }
    if doc.title:
        frontmatter["title"] = doc.title
    if doc.url:
        frontmatter["source_url"] = doc.url
    if doc.author:
        frontmatter["author"] = doc.author
    if doc.source_ts:
        frontmatter["source_ts"] = doc.source_ts
    frontmatter.update(doc.extra_frontmatter)
    # Structured authors last, so scalar extra_frontmatter can never clobber the resolvable signal.
    if doc.authors:
        frontmatter["authors"] = doc.authors

    # Prepend the title so identical bodies under different titles hash distinctly and
    # the indexed text leads with the title.
    body = f"# {doc.title}\n\n{doc.body}" if doc.title else doc.body

    return ItemPayload.build(
        project=project,
        path=_safe_path(doc.source, doc.external_id),
        kind=kind,
        body=body,
        access=access,
        actor=actor,
        frontmatter=frontmatter,
    )
