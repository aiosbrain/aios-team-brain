"""Tests for the codebase analyzer: scaffolding detection accuracy, backfill
idempotency, and graceful behavior without a GitHub token."""

from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

import aios_ingest.analyzers.codebase as codebase_module
from aios_ingest.analyzers.codebase import (
    _analyze_fix_commit,
    _analyze_git,
    _classify_commit_subject,
    _coherent_coverage,
    _coherent_pair,
    _coherent_run,
    _detect_scaffolding,
    _entries_under,
    _int_or_none,
    _read_coverage,
    _read_test_results,
    _resolve_in_repo,
    _tracked_entries,
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


def _git_out(repo, *args) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout


def _init(tmp_path):
    Path(tmp_path).mkdir(parents=True, exist_ok=True)
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "branch", "-m", "main")
    return tmp_path


def test_conventional_commit_classification_is_versioned_and_explicit():
    assert _classify_commit_subject("fix(parser)!: close the gap")["type"] == "fix"
    assert _classify_commit_subject("feat: add dashboard")["type"] == "feat"
    assert _classify_commit_subject("docs: explain evidence")["type"] == "other"
    assert _classify_commit_subject("Repair dashboard")["type"] == "unparseable"
    assert _classify_commit_subject("fix: x")["scheme"] == "conventional-commit-v1"


def test_fix_analysis_uses_first_parent_age_and_prior_fix_counts(tmp_path):
    repo = _init(tmp_path)
    source = repo / "old name.py"
    source.write_text("alpha\nbeta\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "fix: seed alpha", when="2026-01-01T00:00:00Z")

    source.write_text("alpha\nbeta feature\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: extend beta", when="2026-01-05T00:00:00Z")

    _git(repo, "mv", "old name.py", "new name.py")
    (repo / "new name.py").write_text("alpha repaired\nbeta repaired\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "fix: repair both lines", when="2026-01-10T00:00:00Z")

    scan = _analyze_git(repo, 3650)
    latest = scan["recent_commits"][0]
    assert latest["commit_classification"]["type"] == "fix"
    analysis = latest["fix_analysis"]
    assert analysis["method"] == "first-parent-line-blame-v1"
    assert analysis["candidate_parent_lines"] == 2
    assert analysis["blamed_parent_lines"] == 2
    assert sum(analysis["age_buckets"].values()) == 2
    assert analysis["age_buckets"]["2_7d"] == 1
    assert analysis["age_buckets"]["8_30d"] == 1
    assert analysis["prior_fix_parent_lines"] == 1
    assert "path" not in str(analysis).lower()


def test_root_fix_omits_analysis_and_addition_only_fix_reports_zero_counts(tmp_path):
    repo = _init(tmp_path)
    (repo / "first.py").write_text("root\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "fix: root commit", when="2026-02-01T00:00:00Z")

    (repo / "added.py").write_text("new\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "fix: add missing module", when="2026-02-02T00:00:00Z")

    commits = _analyze_git(repo, 3650)["recent_commits"]
    assert commits[0]["fix_analysis"] == {
        "method": "first-parent-line-blame-v1",
        "candidate_parent_lines": 0,
        "blamed_parent_lines": 0,
        "age_buckets": {
            "0_1d": 0,
            "2_7d": 0,
            "8_30d": 0,
            "31_90d": 0,
            "91_365d": 0,
            "366d_plus": 0,
        },
        "prior_fix_parent_lines": 0,
    }
    assert "fix_analysis" not in commits[1]


def test_merge_commits_are_excluded_from_classification_feed(tmp_path):
    repo = _init(tmp_path)
    (repo / "base.py").write_text("base\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: base", when="2026-03-01T00:00:00Z")

    _git(repo, "checkout", "-q", "-b", "feature")
    (repo / "feature.py").write_text("feature\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: branch", when="2026-03-02T00:00:00Z")
    _git(repo, "checkout", "-q", "main")
    (repo / "main.py").write_text("main\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: main", when="2026-03-02T12:00:00Z")
    _git(repo, "merge", "--no-ff", "feature", "-m", "fix: merge branch")

    messages = [commit["message"] for commit in _analyze_git(repo, 3650)["recent_commits"]]
    assert "fix: merge branch" not in messages
    assert messages[:2] == ["feat: main", "feat: branch"]


def test_binary_fix_has_measured_zero_parent_line_candidates(tmp_path):
    repo = _init(tmp_path)
    binary = repo / "asset.bin"
    binary.write_bytes(b"\x00\x01\x02")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: add binary", when="2026-04-01T00:00:00Z")
    binary.write_bytes(b"\x00\x03\x04")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "fix: repair binary", when="2026-04-02T00:00:00Z")

    analysis = _analyze_git(repo, 3650)["recent_commits"][0]["fix_analysis"]
    assert analysis["candidate_parent_lines"] == 0
    assert analysis["blamed_parent_lines"] == 0


def test_shallow_fix_classifies_but_omits_unavailable_parent_analysis(tmp_path):
    source = _init(tmp_path / "source")
    tracked = source / "tracked.py"
    tracked.write_text("before\n")
    _git(source, "add", "-A")
    _git(source, "commit", "-m", "feat: seed", when="2026-05-01T00:00:00Z")
    tracked.write_text("after\n")
    _git(source, "add", "-A")
    _git(source, "commit", "-m", "fix: shallow head", when="2026-05-02T00:00:00Z")

    shallow = tmp_path / "shallow"
    subprocess.run(
        ["git", "clone", "-q", "--depth=1", f"file://{source}", str(shallow)],
        check=True,
        capture_output=True,
    )
    head = _analyze_git(shallow, 3650)["recent_commits"][0]
    assert head["commit_classification"]["type"] == "fix"
    assert "fix_analysis" not in head


def test_unblamable_range_preserves_candidate_gap(tmp_path, monkeypatch):
    repo = _init(tmp_path)
    tracked = repo / "tracked.py"
    tracked.write_text("before\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "feat: seed", when="2026-06-01T00:00:00Z")
    tracked.write_text("after\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "fix: change", when="2026-06-02T00:00:00Z")
    sha = _git_out(repo, "rev-parse", "HEAD").strip()
    real_git = codebase_module._git

    def fail_blame(repo_path, *args):
        if args and args[0] == "blame":
            raise subprocess.CalledProcessError(128, ["git", *args])
        return real_git(repo_path, *args)

    monkeypatch.setattr(codebase_module, "_git", fail_blame)
    analysis = _analyze_fix_commit(
        repo,
        sha,
        datetime.fromisoformat("2026-06-02T00:00:00+00:00"),
    )
    assert analysis is not None
    assert analysis["candidate_parent_lines"] == 1
    assert analysis["blamed_parent_lines"] == 0
    assert sum(analysis["age_buckets"].values()) == 0


def test_entries_under_excludes_doc_files(tmp_path):
    entries = [
        ("100644", "0" * 40, f)
        for f in (
            ".claude/skills/foo/SKILL.md",
            ".claude/skills/bar/SKILL.md",
            ".claude/skills/README.md",
            ".claude/skills/INDEX.md",
            ".claude/commands/deploy.md",
            "pkg/.claude/skills/nested/SKILL.md",
        )
    ]
    # skills: real dirs only (README.md / INDEX.md excluded), incl. nested .claude
    assert _entries_under(entries, tmp_path, "skills") == {"foo", "bar", "nested"}
    # commands are single .md files — counted (only README/INDEX are excluded)
    assert _entries_under(entries, tmp_path, "commands") == {"deploy.md"}


def _write_skill(repo: Path, rel: str) -> None:
    d = repo / rel
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text("---\nname: x\n---\nbody\n")


# ── AIO-996: the three real skill layouts ────────────────────────────────────
# Each fixture asserts the counted total equals the number of distinct SKILL.md
# files the repo actually ships. Layout 1 is the pre-existing behaviour and is
# pinned here so a fix for 2/3 can't silently move it.


def test_skills_count_plain_claude_layout(tmp_path):
    """Layout 1 — `.claude/skills/<name>/SKILL.md`."""
    repo = _init(tmp_path)
    for name in ("alpha", "beta", "gamma"):
        _write_skill(repo, f".claude/skills/{name}")
    (repo / ".claude" / "skills" / "README.md").write_text("docs, not a skill")
    (repo / ".claude" / "commands").mkdir()
    (repo / ".claude" / "commands" / "deploy.md").write_text("cmd")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")

    s = _detect_scaffolding(repo)
    assert len(list(repo.rglob("SKILL.md"))) == 3
    assert s["skills_count"] == 3
    assert s["commands_count"] == 1


def test_skills_count_symlinked_claude_dir(tmp_path):
    """Layout 2 — `.claude/skills` is a symlink to an in-tree `.agents/skills`.

    `git ls-files` emits the symlink as ONE entry with no trailing path, so the
    prefix match never fires and these skills used to count as ZERO
    (aios-marketing: 2 real skills, read as 0).
    """
    repo = _init(tmp_path)
    for name in ("applicant-pipeline", "event-launch"):
        _write_skill(repo, f".agents/skills/{name}")
    (repo / ".claude").mkdir()
    (repo / ".claude" / "skills").symlink_to(Path("..") / ".agents" / "skills")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")

    tracked = _git_out(repo, "ls-files").split()
    assert ".claude/skills" in tracked  # the symlink, tracked as a lone entry
    assert len(list((repo / ".agents").rglob("SKILL.md"))) == 2
    assert _detect_scaffolding(repo)["skills_count"] == 2


def test_symlinked_skills_are_not_double_counted(tmp_path):
    """The symlink AND its target are both visible to `git ls-files`.

    A naive fix (summing per-layout counts, or keying on path) reports 4 here.
    The correct answer is 2 — there are only two SKILL.md files on disk.
    """
    repo = _init(tmp_path)
    for name in ("one", "two"):
        _write_skill(repo, f"skills/{name}")  # pack-source layout AND link target
    (repo / ".claude").mkdir()
    (repo / ".claude" / "skills").symlink_to(Path("..") / "skills")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")

    tracked = _git_out(repo, "ls-files").split()
    assert ".claude/skills" in tracked
    assert "skills/one/SKILL.md" in tracked  # both views tracked simultaneously
    assert len(list(repo.rglob("SKILL.md"))) == 2
    assert _detect_scaffolding(repo)["skills_count"] == 2


def test_skills_count_pack_source_layout(tmp_path):
    """Layout 3 — top-level `skills/<name>/SKILL.md`, no `.claude/` at all.

    The repo IS the skill pack (aios-engineering-harness: 18 skills, read as 0).
    """
    repo = _init(tmp_path)
    for name in ("ast-grep", "code-review", "git-master"):
        _write_skill(repo, f"skills/{name}")
    (repo / "skills" / "README.md").write_text("index, not a skill")  # no SKILL.md
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")

    assert len(list(repo.rglob("SKILL.md"))) == 3
    assert _detect_scaffolding(repo)["skills_count"] == 3


def test_pack_source_needs_the_skill_md_marker(tmp_path):
    """An ordinary source dir called `skills/` must NOT inflate the count.

    Without the SKILL.md gate, any CLI with a `skills/` package would read as
    agentic — the false positive that makes the metric meaningless.
    """
    repo = _init(tmp_path)
    for name in ("parse", "render"):
        d = repo / "skills" / name
        d.mkdir(parents=True)
        (d / "index.ts").write_text("export const x = 1;\n")
    # nested/vendored pack sources are out of scope too — root-level only
    _write_skill(repo, "vendor/pkg/skills/borrowed")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")

    assert _detect_scaffolding(repo)["skills_count"] == 0


def test_resolve_in_repo_rejects_every_escape():
    """The containment invariant, asserted on the unit.

    Asserting it only through `skills_count` would pass for the wrong reason: an
    out-of-repo prefix matches nothing in `git ls-files` output either way, so the
    count is over-determined and the check could be deleted with the suite green.
    """
    # in-repo targets resolve, relative to the LINK's directory
    assert _resolve_in_repo(".claude/skills", "../.agents/skills") == ".agents/skills"
    assert _resolve_in_repo(".claude/skills", "../skills") == "skills"
    assert _resolve_in_repo("pkg/.claude/skills", "../skills") == "pkg/skills"
    assert _resolve_in_repo("pkg/.claude/skills", "../../skills") == "skills"
    assert _resolve_in_repo(".claude/skills", "./sub") == ".claude/sub"
    # …and every way out of the checkout is refused
    assert _resolve_in_repo(".claude/skills", "/etc/passwd") is None
    assert _resolve_in_repo(".claude/skills", "../../outside/skills") is None
    assert _resolve_in_repo(".claude/skills", "../../../../../../tmp") is None
    assert _resolve_in_repo(".claude/skills", "C:/windows") is None
    assert _resolve_in_repo(".claude/skills", "") is None


def test_symlink_escaping_the_repo_is_ignored(tmp_path):
    """End-to-end: a link out of the checkout contributes nothing and doesn't crash."""
    outside = tmp_path / "outside"
    _write_skill(outside, "skills/leaked")
    repo = _init(tmp_path / "repo")
    _write_skill(repo, ".claude/skills/real")
    (repo / ".claude" / "commands").symlink_to(Path("..") / ".." / "outside" / "skills")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")

    s = _detect_scaffolding(repo)
    assert s["skills_count"] == 1
    assert s["commands_count"] == 0  # the escaping link contributes nothing


def test_symlink_layout_survives_a_core_symlinks_false_checkout(tmp_path):
    """`core.symlinks=false` writes the link as a REGULAR FILE holding its target.

    That is git's default on Windows without Developer Mode, and any clone made with
    `-c core.symlinks=false`. A filesystem `is_symlink()` gate reads False there and
    the symlinked layout silently reverts to counting ZERO — the original bug, back.
    """
    origin = _init(tmp_path / "origin")
    for name in ("applicant-pipeline", "event-launch"):
        _write_skill(origin, f".agents/skills/{name}")
    (origin / ".claude").mkdir()
    (origin / ".claude" / "skills").symlink_to(Path("..") / ".agents" / "skills")
    _git(origin, "add", "-A")
    _git(origin, "commit", "-m", "init")

    clone = tmp_path / "clone"
    subprocess.run(
        ["git", "clone", "-q", "-c", "core.symlinks=false", str(origin), str(clone)],
        check=True,
        capture_output=True,
    )
    assert not (clone / ".claude" / "skills").is_symlink()  # a plain file on disk
    assert (clone / ".claude" / "skills").read_text().strip() == "../.agents/skills"
    assert _detect_scaffolding(clone)["skills_count"] == 2


def test_non_ascii_skill_names_are_counted(tmp_path):
    """git C-quotes non-ASCII paths unless `core.quotePath=false`.

    Left on, `git ls-files` emits `"skills/caf\303\251/SKILL.md"` — leading quote
    included — and every prefix match downstream misses it.
    """
    repo = _init(tmp_path)
    _write_skill(repo, "skills/café")
    _write_skill(repo, "skills/日本語")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")

    assert all(not p.startswith('"') for _, _, p in _tracked_entries(repo))
    assert _detect_scaffolding(repo)["skills_count"] == 2


def test_categorised_pack_root_counts_skills_not_categories(tmp_path):
    """`skills/<category>/<name>/SKILL.md` — the skill is the manifest's DIRECTORY.

    Keying on the second path segment reports the number of CATEGORIES under a field
    labelled a skill count: hermes-agent read 26 for 97 real skills.
    """
    repo = _init(tmp_path)
    for rel in (
        "skills/comms/slack-cli",
        "skills/comms/voice-and-rules",
        "skills/eng/refactor",
        "skills/flat-one",  # a flat pack root still works alongside a categorised one
    ):
        _write_skill(repo, rel)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")

    assert len(list(repo.rglob("SKILL.md"))) == 4
    assert _detect_scaffolding(repo)["skills_count"] == 4


def test_undecodable_filename_does_not_abort_the_scan(tmp_path):
    """A filename that is not valid UTF-8 must not blow up the whole scan.

    git indexes such paths happily; `core.quotePath=false` stops the C-quoting that
    used to keep the stream ASCII, so strict decoding would raise UnicodeDecodeError
    out of `_detect_scaffolding` → `analyze_repo` and lose the entire repo's metrics
    over one bad name. Staged via the index because APFS rejects the bytes on disk.
    """
    repo = _init(tmp_path)
    (repo / "a.txt").write_text("x")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")
    blob = subprocess.run(
        ["git", "hash-object", "-w", "--stdin"],
        cwd=repo, input=b"---\nname: x\n---\n", capture_output=True, check=True,
    ).stdout.decode().strip()
    bad_name = b"skills/\xff\xfebad/SKILL.md".decode("utf-8", "surrogateescape")
    subprocess.run(
        ["git", "update-index", "--add", "--cacheinfo", "100644", blob, bad_name],
        cwd=repo, capture_output=True, check=True,
    )

    s = _detect_scaffolding(repo)  # must not raise
    assert s["skills_count"] == 1  # the undecodable name still counts
    assert s["files"] == 2


def test_pack_root_accepts_a_suffixed_skills_dir(tmp_path):
    """`optional-skills/` is a real pack root in the wild; `test/` is not."""
    repo = _init(tmp_path)
    _write_skill(repo, "skills/core")
    _write_skill(repo, "optional-skills/finance")
    _write_skill(repo, "test/skill-scan-fixtures/dummy")  # a FIXTURE, not a skill
    _write_skill(repo, "gui/server/pretend")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "init")

    assert _detect_scaffolding(repo)["skills_count"] == 2


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
    assert m["test_coverage_pct"] is None  # no report on disk
    assert m["test_coverage_functions_pct"] is None
    assert m["test_coverage_branches_pct"] is None


def test_read_coverage_istanbul_all_three(tmp_path):
    """Istanbul coverage-summary.json yields lines/functions/branches percentages + counts."""
    cov = tmp_path / "coverage"
    cov.mkdir()
    (cov / "coverage-summary.json").write_text(
        '{"total": {"lines": {"pct": 31.67, "total": 9752, "covered": 3088},'
        ' "functions": {"pct": 34.33}, "branches": {"pct": 25.7}}}'
    )
    assert _read_coverage(tmp_path) == {
        "lines": 31.67,
        "functions": 34.33,
        "branches": 25.7,
        "lines_total": 9752,
        "lines_covered": 3088,
    }


def test_read_coverage_istanbul_counts_optional(tmp_path):
    """An Istanbul report with pct but no counts still yields the pct — counts fall to None.

    A percentage without a denominator is exactly the state AIO-995 exists to expose, so it
    must remain readable rather than being rejected as malformed.
    """
    cov = tmp_path / "coverage"
    cov.mkdir()
    (cov / "coverage-summary.json").write_text('{"total": {"lines": {"pct": 31.67}}}')
    got = _read_coverage(tmp_path)
    assert got["lines"] == 31.67
    assert got["lines_total"] is None and got["lines_covered"] is None


def test_read_coverage_lcov_all_three(tmp_path):
    """LCOV lcov.info yields percentages AND the LF/LH sums they were divided from."""
    cov = tmp_path / "coverage"
    cov.mkdir()
    (cov / "lcov.info").write_text("\n".join(["LF:200", "LH:100", "FNF:40", "FNH:30", "BRF:50", "BRH:20", "end_of_record"]))
    assert _read_coverage(tmp_path) == {
        "lines": 50.0,
        "functions": 75.0,
        "branches": 40.0,
        "lines_total": 200,
        "lines_covered": 100,
    }


def test_read_coverage_none_when_absent(tmp_path):
    """No report → every field None (so the scanner pushes nulls, not zeros)."""
    assert _read_coverage(tmp_path) == {
        "lines": None,
        "functions": None,
        "branches": None,
        "lines_total": None,
        "lines_covered": None,
    }


def test_read_test_results_none_when_absent(tmp_path):
    """No test-result report → all None.

    NOT zeros. `{"skipped": 0}` is the claim "this run skipped nothing", which a repo with no
    report has not made and the brain must not infer (AIO-995).
    """
    assert _read_test_results(tmp_path) == {
        "total": None,
        "passed": None,
        "skipped": None,
        "failed": None,
    }


def test_read_test_results_vitest_json(tmp_path):
    """Vitest/Jest JSON reporter counts, with pending + todo summed into `skipped`."""
    cov = tmp_path / "coverage"
    cov.mkdir()
    (cov / "test-results.json").write_text(
        json.dumps(
            {
                "numTotalTests": 229,
                "numPassedTests": 135,
                "numPendingTests": 88,
                "numTodoTests": 3,
                "numFailedTests": 3,
            }
        )
    )
    assert _read_test_results(tmp_path) == {
        "total": 229,
        "passed": 135,
        "skipped": 91,
        "failed": 3,
    }


def test_read_test_results_junit_sums_suites(tmp_path):
    """JUnit XML: suites are summed, and errors count as failures.

    The aios-workspace-gui shape — a run with both failures and skips, which coverage alone
    reports as a plausible percentage with nothing red.
    """
    (tmp_path / "junit.xml").write_text(
        '<testsuites>'
        '<testsuite tests="200" skipped="30" failures="20" errors="2"/>'
        '<testsuite tests="251" skipped="28" failures="5" errors="0"/>'
        "</testsuites>"
    )
    assert _read_test_results(tmp_path) == {
        "total": 451,
        "passed": 451 - 58 - 27,
        "skipped": 58,
        "failed": 27,
    }


def test_read_test_results_junit_bare_testsuite(tmp_path):
    """A JUnit file whose root is a single <testsuite> (no <testsuites> wrapper) still parses."""
    (tmp_path / "test-results.xml").write_text('<testsuite tests="10" skipped="1" failures="0"/>')
    assert _read_test_results(tmp_path) == {
        "total": 10,
        "passed": 9,
        "skipped": 1,
        "failed": 0,
    }


def test_read_test_results_malformed_xml_is_unknown_not_a_crash(tmp_path):
    """A malformed report degrades to UNKNOWN — it must never abort a scan or report zeros."""
    (tmp_path / "junit.xml").write_text("<testsuites><testsuite tests=")
    assert _read_test_results(tmp_path)["total"] is None


def test_junit_errors_outside_tests_do_not_produce_failed_gt_total(tmp_path):
    """pytest emits `<testsuite tests="0" errors="1"/>` for a collection error.

    Taken at face value that is failed=1, total=0 — which the brain rejects at the boundary,
    losing the ENTIRE scan (contributions and issues included) over one degraded report. The
    total must be at least the sum of its parts.
    """
    (tmp_path / "junit.xml").write_text('<testsuite tests="0" errors="1" failures="0" skipped="0"/>')
    got = _read_test_results(tmp_path)
    assert got["failed"] == 1
    assert got["total"] >= got["failed"], "failed must never exceed total"
    assert got["passed"] == 0


def test_junit_nested_rollup_suites_are_not_double_counted(tmp_path):
    """Aggregated JUnit files nest <testsuite> inside <testsuite> with rolled-up parent counts.

    Summing every descendant counts each test twice — inflating the totals and able to make a
    clean run report as partial.
    """
    (tmp_path / "junit.xml").write_text(
        "<testsuites>"
        '<testsuite name="all" tests="10" skipped="2" failures="0">'
        '<testsuite name="a" tests="6" skipped="2" failures="0"/>'
        '<testsuite name="b" tests="4" skipped="0" failures="0"/>'
        "</testsuite>"
        "</testsuites>"
    )
    assert _read_test_results(tmp_path) == {"total": 10, "passed": 8, "skipped": 2, "failed": 0}


def test_negative_counts_are_voided_to_unknown_not_shipped():
    """A count below zero must never reach the brain — it 422s the payload and drops the scan.

    An ordering test alone waves negatives through, because `-2 > -1` is false. That is how the
    first version of this guard shipped: it closed the collection-error path and left the class
    open. The route returns before `recordIngestRun`, so the loss would not even reach the run
    log.
    """
    assert _coherent_pair(-1, -2) == (None, None)
    assert _coherent_pair(100, -1) == (None, None)
    assert _coherent_pair(-1, None) == (None, None)
    assert _coherent_run(10, -1, 0, 0) == (None, None, None, None)
    assert _coherent_run(-5, None, None, None) == (None, None, None, None)
    assert _int_or_none(-5) == -5, "the raw reader stays literal; the choke point is the normalizer"


def test_run_parts_must_fit_inside_the_total_together():
    """`{total:10, passed:10, skipped:10, failed:10}` passes three pairwise checks and is absurd."""
    assert _coherent_run(10, 10, 10, 10) == (None, None, None, None)
    assert _coherent_run(10, 5, 3, 2) == (10, 5, 3, 2)  # sums exactly
    assert _coherent_run(10, 5, 3, 1) == (10, 5, 3, 1)  # under-sums: unallocated, not contradictory
    # The KNOWN parts alone already exceed the total: 9 passed + 9 failed is impossible in a
    # ten-test run whatever the skip count turns out to be. Summing only when all three are
    # present would have shipped this.
    assert _coherent_run(10, 9, None, 9) == (None, None, None, None)
    # A known part that leaves room is fine with the rest unknown.
    assert _coherent_run(10, 4, None, None) == (10, 4, None, None)


def test_coverage_counts_are_voided_when_they_contradict_the_percentage():
    """99% next to 0-of-100 covered lines is two incompatible claims; the brain 422s the pair.

    The COUNTS drop, never the percentage — degrading back to exactly what this repo reported
    before 1.22 (a percentage of unknown scope), rather than losing the whole scan.
    """
    assert _coherent_coverage(99.0, 100, 0) == (None, None)
    assert _coherent_coverage(99.0, 100, 99) == (100, 99)
    # Rounding is not a contradiction: tools round to 2dp and the tolerance is a full point.
    assert _coherent_coverage(99.0, 3, 3) == (3, 3)
    # Nothing to compare against.
    assert _coherent_coverage(None, 100, 99) == (100, 99)
    assert _coherent_coverage(99.0, 0, 0) == (0, 0)


def test_namespaced_junit_is_read_not_silently_dropped(tmp_path):
    """ElementTree renders a namespaced tag as `{urn:junit}testsuite`.

    An equality test against "testsuite" matches nothing, so a perfectly good report became
    "no report" — the exact silent degradation these fields exist to surface.
    """
    (tmp_path / "junit.xml").write_text(
        '<testsuites xmlns="urn:junit">'
        '<testsuite tests="229" skipped="91" failures="0" errors="0"/>'
        "</testsuites>"
    )
    assert _read_test_results(tmp_path) == {
        "total": 229,
        "passed": 138,
        "skipped": 91,
        "failed": 0,
    }


def test_namespaced_junit_rollups_are_still_leaf_only(tmp_path):
    """The leaf rule must survive the namespace fix — both use the local name."""
    (tmp_path / "junit.xml").write_text(
        '<testsuites xmlns="urn:junit">'
        '<testsuite name="all" tests="10" skipped="2" failures="0">'
        '<testsuite name="a" tests="6" skipped="2" failures="0"/>'
        '<testsuite name="b" tests="4" skipped="0" failures="0"/>'
        "</testsuite>"
        "</testsuites>"
    )
    assert _read_test_results(tmp_path) == {"total": 10, "passed": 8, "skipped": 2, "failed": 0}


def test_a_negative_report_ships_as_unknown_end_to_end(tmp_path):
    """The whole point: a malformed report costs the SCOPE, never the scan."""
    repo = _init(tmp_path)
    (repo / "a.ts").write_text("const a = 1;\n" * 40)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "c1")
    cov = repo / "coverage"
    cov.mkdir()
    (cov / "coverage-summary.json").write_text(
        '{"total": {"lines": {"pct": 99.0, "total": -1, "covered": -2}}}'
    )
    m = analyze_repo(str(repo), slug="x")["metrics"]
    # The headline percentage survives — that is the pre-1.22 behaviour and it is not in doubt.
    assert m["test_coverage_pct"] == 99.0
    # The counts do not, because the brain would refuse them and take the whole payload with it.
    assert m["test_coverage_lines_total"] is None
    assert m["test_coverage_lines_covered"] is None
    # And the rest of the scan is intact.
    assert m["loc"] == 40 and m["commits_window"] == 1


def test_incoherent_counts_are_voided_to_unknown_not_shipped():
    """The scanner must never emit a pair the brain will 422 the whole payload over."""
    # Coherent pairs pass through untouched, including equality.
    assert _coherent_pair(100, 100) == (100, 100)
    assert _coherent_pair(100, None) == (100, None)
    assert _coherent_pair(None, 40) == (None, 40)
    # A numerator that doesn't fit its denominator voids BOTH — the report was parsed wrong.
    assert _coherent_pair(100, 101) == (None, None)

    assert _coherent_run(10, 5, 3, 2) == (10, 5, 3, 2)
    assert _coherent_run(None, 5, 3, 2) == (None, 5, 3, 2)
    # Voided as a group: keeping `skipped` from a report whose total we disbelieved would let
    # the dashboard call a run partial on evidence we just rejected.
    assert _coherent_run(10, 5, 11, 2) == (None, None, None, None)


def test_scan_payload_carries_the_coverage_denominator(tmp_path):
    """End to end: analyze_repo emits the six 1.22 fields, null when there is no report.

    The contract rule this pins: an omitting scan sends nulls for all six, so a pre-1.22-shaped
    repo produces a payload the brain reads as "scope unknown" rather than "scope zero".
    """
    repo = _init(tmp_path)
    (repo / "a.ts").write_text("const a = 1;\n" * 40)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "c1")

    m = analyze_repo(str(repo), slug="x")["metrics"]
    for key in (
        "test_coverage_lines_total",
        "test_coverage_lines_covered",
        "tests_total",
        "tests_passed",
        "tests_skipped",
        "tests_failed",
    ):
        assert key in m, f"{key} missing from the scan payload"
        assert m[key] is None

    cov = repo / "coverage"
    cov.mkdir()
    (cov / "coverage-summary.json").write_text(
        '{"total": {"lines": {"pct": 99.0, "total": 20, "covered": 20}}}'
    )
    (cov / "test-results.json").write_text(
        json.dumps({"numTotalTests": 8, "numPassedTests": 6, "numPendingTests": 2, "numFailedTests": 0})
    )
    m2 = analyze_repo(str(repo), slug="x")["metrics"]
    assert m2["test_coverage_pct"] == 99.0
    # 20 instrumented lines against 40 counted lines: the percentage covers half the repo, and
    # that fact now rides along with it.
    assert m2["test_coverage_lines_total"] == 20
    assert m2["loc"] == 40
    assert m2["tests_skipped"] == 2 and m2["tests_total"] == 8


def test_history_backfill_leaves_the_1_22_fields_unknown(tmp_path):
    """A historical snapshot has no coverage or test report at that SHA — six nulls, no crash."""
    repo = _init(tmp_path)
    (repo / "a.ts").write_text("const a = 1;\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-m", "c1")
    points = analyze_history(str(repo), slug="x", weeks=2)
    assert points, "expected at least one historical point"
    for point in points:
        assert point["metrics"]["test_coverage_lines_total"] is None
        assert point["metrics"]["tests_skipped"] is None


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
