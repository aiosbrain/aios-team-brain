"""Vendored rubric integrity — mirrors agentic-engineering-maturity/rubric/validate.mjs.

A corrupted/edited vendored copy is caught here (CI-running). The vendored-vs-canonical
comparison is a LOCAL-ONLY guard: it skips when the sibling repo isn't checked out, so CI
never silently passes on a copy it couldn't compare. Refresh with scripts/refresh-rubric.sh."""

from __future__ import annotations

import json
from importlib import resources
from pathlib import Path

import pytest


def _vendored() -> dict:
    res = resources.files("aios_ingest.rubric") / "agent-readiness.json"
    return json.loads(res.read_text(encoding="utf-8"))


def test_vendored_rubric_is_well_formed():
    r = _vendored()
    for key in ("version", "levels", "pillars", "checks", "advanceThreshold",
                "verificationCapLevel", "verificationCapPillar"):
        assert key in r, f"rubric missing top-level key: {key}"

    pillar_keys = {p["key"] for p in r["pillars"]}
    level_ids = {lvl["id"] for lvl in r["levels"]}
    assert f"L{r['verificationCapLevel']}" in level_ids
    assert r["verificationCapPillar"] in pillar_keys

    seen = set()
    for c in r["checks"]:
        for field in ("id", "pillar", "level", "signal"):
            assert field in c, f"check missing {field}: {c.get('id', '?')}"
        assert c["id"] not in seen, f"duplicate check id: {c['id']}"
        seen.add(c["id"])
        assert c["pillar"] in pillar_keys, f"check {c['id']} unknown pillar {c['pillar']}"
        assert c["level"] in level_ids, f"check {c['id']} unknown level {c['level']}"


# Canonical lives in a sibling repo; present on a dev checkout, absent in CI.
_CANONICAL = (
    Path(__file__).resolve().parents[3]
    / "agentic-engineering-maturity" / "rubric" / "agent-readiness.json"
)


@pytest.mark.skipif(not _CANONICAL.is_file(), reason="canonical rubric not checked out (CI)")
def test_vendored_matches_canonical():
    canonical = json.loads(_CANONICAL.read_text(encoding="utf-8"))
    assert _vendored() == canonical, (
        "vendored rubric drifted from canonical — run scripts/refresh-rubric.sh"
    )
