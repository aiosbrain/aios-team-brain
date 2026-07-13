"""Tests for the codebase analyzer: scaffolding detection accuracy, backfill
idempotency, and graceful behavior without a GitHub token."""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aios_ingest.analyzers.codebase import (
    _detect_scaffolding,
    _entries_under,
    _read_coverage,
    analyze_history,
    analyze_repo,
)


def _git(repo, *args, when: str | None = None):
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "T",
        "GIT_AUTHOR_EMAIL": "t@x.test",
        "GIT_COMMITTER_NAME": "T",
        "GIT_COMMITTER_EMAIL": "t@x.test",
    }
    if when:
        env["GIT_AUTHOR_DATE"] = when
        env["GIT_COMMITTER_DATE"] = when
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, env=env)


def _init(tmp_path):
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "branch", "-m", "main")
    return tmp_path


def test_entries_under_excludes_doc_files():
    tracked = [
        ".claude/skills/foo/SKILL.md",
        ".claude/skills/bar/SKILL.md",
        ".claude/skills/README.md",
        ".claude/skills/INDEX.md",
        ".claude/commands/deploy.md",
        "pkg/.claude/skills/nested/SKILL.md",
    ]
    # skills: real dirs only (README.md / INDEX.md excluded), incl. nested .claude
    assert _entries_under(tracked, "skills") == {"foo", "bar", "nested"}
    # commands are single .md files — counted (only README/INDEX are excluded)
    assert _entries_under(tracked, "commands") == {"deploy.md"}


def test_agents_md_basename_no_false_positive(tmp_path):
    repo = _init(tmp_path)
    (repo / "AGENTS.md").write_text("real")
    (repo / "gui").mkdir()
    (repo / "gui" / "managed-agents.md").write_text("not an AGENTS.md")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")
    s = _detect_scaffolding(repo)
    assert s["has_agents_md"] is True
    assert s["agents_md_count"] == 1  # AGENTS.md only — managed-agents.md must not match


def test_analyze_history_distinct_points_and_idempotent(tmp_path):
    repo = _init(tmp_path)
    now = datetime.now(timezone.utc)
    d2 = (now - timedelta(days=2)).isoformat()
    d1 = (now - timedelta(days=1)).isoformat()
    (repo / "a.txt").write_text("1")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "c1", when=d2)
    (repo / "a.txt").write_text("2")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "c2", when=d1)

    p1 = analyze_history(str(repo), slug="x", window_days=90, weeks=2)
    p2 = analyze_history(str(repo), slug="x", window_days=90, weeks=2)
    shas1 = [pt["metrics"]["head_sha"] for pt in p1]
    # two commits on distinct days → at least two distinct historical points
    assert len(set(shas1)) >= 2
    assert len(shas1) == len(set(shas1))  # deduped by SHA
    # idempotent: same SHAs on a repeat run (no same-HEAD duplication)
    assert sorted(shas1) == sorted(pt["metrics"]["head_sha"] for pt in p2)


def test_no_github_token_means_no_issues(tmp_path, monkeypatch):
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    repo = _init(tmp_path)
    (repo / "a.txt").write_text("1")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "c1")
    payload = analyze_repo(str(repo), slug="x", full_name="org/x")
    assert payload["issues"] == []
    m = payload["metrics"]
    assert m["test_coverage_pct"] is None  # no committed report
    assert m["test_coverage_functions_pct"] is None
    assert m["test_coverage_branches_pct"] is None


def test_read_coverage_istanbul_all_three(tmp_path):
    """Istanbul coverage-summary.json yields lines/functions/branches percentages."""
    cov = tmp_path / "coverage"
    cov.mkdir()
    (cov / "coverage-summary.json").write_text(
        '{"total": {"lines": {"pct": 31.67}, "functions": {"pct": 34.33}, "branches": {"pct": 25.7}}}'
    )
    assert _read_coverage(tmp_path) == {"lines": 31.67, "functions": 34.33, "branches": 25.7}


def test_read_coverage_lcov_all_three(tmp_path):
    """LCOV lcov.info yields lines/functions/branches computed from hit/found totals."""
    cov = tmp_path / "coverage"
    cov.mkdir()
    (cov / "lcov.info").write_text("\n".join(["LF:200", "LH:100", "FNF:40", "FNH:30", "BRF:50", "BRH:20", "end_of_record"]))
    assert _read_coverage(tmp_path) == {"lines": 50.0, "functions": 75.0, "branches": 40.0}


def test_read_coverage_none_when_absent(tmp_path):
    """No report → all three None (so the scanner pushes nulls, not zeros)."""
    assert _read_coverage(tmp_path) == {"lines": None, "functions": None, "branches": None}


def test_live_scan_carries_scored_readiness(tmp_path):
    """analyze_repo scores readiness against the vendored rubric and emits all 4 keys."""
    repo = _init(tmp_path)
    (repo / "README.md").write_text("# x")
    (repo / "package.json").write_text("{}")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "c1")
    m = analyze_repo(str(repo), slug="x")["metrics"]
    assert m["readiness_level"] == "L1"             # README + manifest
    assert isinstance(m["readiness_pct"], float)
    assert m["readiness_pillars"]["docs"]["passed"] == 1
    assert m["readiness_rubric_version"] == "1.1.0"


def test_ai_commit_detection_is_model_agnostic(tmp_path):
    """_AI_TRAILER must recognize every AI coding tool's trailer, not just Claude's.

    Shared with test/github-api-scan.test.ts's isAiAssisted suite — both detectors must
    agree on every case in the fixture, so they can't silently diverge again the way the
    Python-only "claude" regex and the TS AI_MARKERS list already had."""
    fixture_path = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "ai-trailer-cases.json"
    cases = json.loads(fixture_path.read_text())

    repo = _init(tmp_path)
    (repo / "seed.txt").write_text("x")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "seed")

    expected_ai_commits = 0
    for i, case in enumerate(cases):
        (repo / f"f{i}.txt").write_text(str(i))
        _git(repo, "add", "-A")
        _git(repo, "commit", "-m", case["message"])
        expected_ai_commits += 1 if case["expected"] else 0

    m = analyze_repo(str(repo), slug="x")["metrics"]
    assert m["ai_commits_window"] == expected_ai_commits


def test_history_points_carry_null_readiness(tmp_path):
    """Historical backfill points are NOT scored — they carry the schema-safe null shape."""
    now = datetime.now(timezone.utc)
    repo = _init(tmp_path)
    (repo / "CLAUDE.md").write_text("x" * 500)  # would score if mis-wired
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "c1", when=(now - timedelta(days=1)).isoformat())
    for pt in analyze_history(str(repo), slug="x", window_days=90, weeks=2):
        m = pt["metrics"]
        assert m["readiness_level"] is None
        assert m["readiness_pct"] is None
        assert m["readiness_pillars"] == {}
        assert m["readiness_rubric_version"] is None
