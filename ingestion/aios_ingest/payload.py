"""The brain's ItemPayload contract, mirrored in Python.

Source of truth: ``lib/api/schemas.ts`` (itemPayloadSchema) in the brain repo, which
itself mirrors the pinned contract ``aios-workspace/docs/brain-api.md`` (v1). Keep this
file in lockstep with that schema — the brain re-validates with Zod and 422s on mismatch.
"""

from __future__ import annotations

import hashlib
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

# Mirrors the item_kind enum + Zod enum. 'admin'/'private' tiers never appear here:
# the brain rejects them with 422, and connectors must never emit them.
ItemKind = Literal["deliverable", "transcript", "decision", "task", "artifact", "skill"]
AccessTier = Literal["team", "external"]

_SHA256_HEX = 64


def sha256_hex(body: str) -> str:
    """content_sha256 over the normalized body. Computed caller-side per contract;
    the brain only validates the ``^[a-f0-9]{64}$`` format and uses it for dedup."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


class TaskRow(BaseModel):
    """A markdown task-table row (materializes into the brain's tasks table)."""

    row_key: str = Field(min_length=1)
    title: str
    assignee: str = ""
    status: str = ""
    sprint: str = ""
    due: str | None = None


class DecisionRow(BaseModel):
    """A markdown decision-table row (materializes into the brain's decisions table)."""

    row_key: str = Field(min_length=1)
    title: str
    decided_at: str | None = None
    rationale: str = ""
    decided_by: str = ""
    impact: str = ""
    tier: int | None = None
    audience: str = "team"


class ItemPayload(BaseModel):
    """One synced item. Matches ``POST /api/v1/items`` request body exactly."""

    project: str = Field(min_length=1, max_length=120)
    path: str = Field(min_length=1, max_length=500)
    kind: ItemKind
    content_sha256: str
    access: AccessTier
    body: str = Field(max_length=1_000_000)
    actor: str = Field(default="", max_length=120)
    frontmatter: dict[str, Any] = Field(default_factory=dict)
    rows: list[dict[str, Any]] | None = None

    @field_validator("content_sha256")
    @classmethod
    def _hex64(cls, v: str) -> str:
        if len(v) != _SHA256_HEX or any(c not in "0123456789abcdef" for c in v):
            raise ValueError("content_sha256 must be 64 lowercase hex chars")
        return v

    @classmethod
    def build(
        cls,
        *,
        project: str,
        path: str,
        kind: ItemKind,
        body: str,
        access: AccessTier = "team",
        actor: str = "",
        frontmatter: dict[str, Any] | None = None,
        rows: list[dict[str, Any]] | None = None,
    ) -> "ItemPayload":
        """Construct an item, computing content_sha256 from the body for the caller."""
        return cls(
            project=project,
            path=path,
            kind=kind,
            content_sha256=sha256_hex(body),
            access=access,
            body=body,
            actor=actor,
            frontmatter=frontmatter or {},
            rows=rows,
        )

    def to_json(self) -> dict[str, Any]:
        # exclude_none keeps `rows` out when unused (matches the optional field).
        return self.model_dump(exclude_none=True)
