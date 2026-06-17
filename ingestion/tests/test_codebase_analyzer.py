"""Tests for the codebase analyzer: scaffolding detection accuracy, backfill
idempotency, and graceful behavior without a GitHub token."""

from __future__ import annotations

import os
import subprocess
from datetime import datetime, timedelta, timezone

from aios_ingest.analyzers.codebase import (
    _detect_scaffolding,
    _entries_under,
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
    assert payload["metrics"]["test_coverage_pct"] is None  # no committed report
