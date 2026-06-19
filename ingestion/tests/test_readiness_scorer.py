"""Agent-readiness scorer tests — deterministic, synthetic git repos with unambiguous
expected levels. Each matcher type, the glob engine (root + nested + braces), the
verification cap, path-escape safety, the failure→null path, and package-data loading."""

from __future__ import annotations

import json
import os
import subprocess

import pytest

from aios_ingest.analyzers.codebase import analyze_repo
from aios_ingest.analyzers.readiness import (
    _expand_braces,
    _glob_match,
    _safe_rel,
    score_readiness,
)

# ── helpers ──────────────────────────────────────────────────────────────────────────────

_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@x.test",
    "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@x.test",
}


def _repo(tmp_path, files: dict[str, str]):
    """Init a git repo, write+commit `files` (relpath → contents), return its Path."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True, env=_ENV)
    subprocess.run(["git", "branch", "-m", "main"], cwd=tmp_path, check=True, env=_ENV)
    for rel, content in files.items():
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=tmp_path, check=True, env=_ENV)
    subprocess.run(["git", "commit", "-qm", "seed"], cwd=tmp_path, check=True, env=_ENV)
    return tmp_path


_BIG = "x" * 2100  # >= 2000 bytes → satisfies present + nontrivial + compounding

# 16 non-testing checks all pass; the 2 testing checks (tests_present, ci_on_pr) are absent.
_ALL_BUT_TESTING = {
    "README.md": "# x",                                   # readme_present (L1 docs)
    "package.json": json.dumps({"dependencies": {"pino": "^9"}}),  # buildable + observability
    "tsconfig.json": "{}",                                # type_checker
    "CLAUDE.md": _BIG,                                    # present + nontrivial + compounding
    ".eslintrc.json": "{}",                               # linter
    ".prettierrc": "{}",                                  # formatter
    ".pre-commit-config.yaml": "repos: []",               # precommit_hooks
    "Makefile": "build:\n\techo hi",                      # one_command_setup
    "CONTRIBUTING.md": "how to",                          # setup_docs
    ".gitignore": ".env\n",                               # secret_scanning
    "evals/basic.eval.ts": "// eval",                     # eval_harness (**/*.eval.*)
    ".claude/skills/foo/SKILL.md": "skill",               # shared_skills_commands
    "llms.txt": "for agents",                             # agent_readable_docs
}


# ── glob engine ──────────────────────────────────────────────────────────────────────────

def test_glob_double_star_root_and_nested():
    assert _glob_match(["logger.ts"], "**/logger.*")
    assert _glob_match(["src/logger.ts"], "**/logger.*")
    assert _glob_match(["tests/foo.py"], "**/tests/**")
    assert _glob_match(["pkg/tests/foo.py"], "**/tests/**")


def test_glob_brace_expansion():
    assert _expand_braces("**/promptfoo*.{yml,yaml,json}") == [
        "**/promptfoo*.yml", "**/promptfoo*.yaml", "**/promptfoo*.json",
    ]
    assert _glob_match(["promptfoo.yaml"], "**/promptfoo*.{yml,yaml,json}")
    assert _glob_match(["promptfoo.json"], "**/promptfoo*.{yml,yaml,json}")
    assert not _glob_match(["promptfoo.toml"], "**/promptfoo*.{yml,yaml,json}")


def test_glob_single_star_does_not_cross_slash():
    assert _glob_match(["foo.py"], "*.py")
    assert not _glob_match(["src/foo.py"], "*.py")
    assert _glob_match(["src/foo.py"], "src/*.py")
    assert not _glob_match(["src/sub/foo.py"], "src/*.py")


# ── matcher types (via score_readiness pillar deltas) ────────────────────────────────────

def test_matcher_fileminbytes_threshold(tmp_path):
    """agent_instructions_nontrivial passes at >=400 bytes, not below."""
    small = _repo(tmp_path / "s", {"CLAUDE.md": "x" * 100})
    big = _repo(tmp_path / "b", {"CLAUDE.md": "x" * 500})
    sp = score_readiness(small)["readiness_pillars"]["agent_instructions"]
    bp = score_readiness(big)["readiness_pillars"]["agent_instructions"]
    assert sp["passed"] == 1   # present only (file exists)
    assert bp["passed"] == 2   # present + nontrivial


def test_matcher_configkey_pyproject_section(tmp_path):
    """linter via orConfigKey [tool.ruff] in pyproject.toml (no eslintrc file)."""
    repo = _repo(tmp_path, {"pyproject.toml": "[tool.ruff]\nline-length = 100\n"})
    cq = score_readiness(repo)["readiness_pillars"]["code_quality"]
    assert cq["passed"] == 1   # linter via tool.ruff; formatter/precommit absent


def test_matcher_dependency_optional_group(tmp_path):
    """observability via orDependency in a pyproject optional-dependencies group."""
    repo = _repo(tmp_path, {
        "pyproject.toml": "[project]\nname='x'\nversion='0'\n"
                          "[project.optional-dependencies]\nobs = ['structlog>=24']\n",
    })
    obs = score_readiness(repo)["readiness_pillars"]["observability"]
    assert obs["passed"] == 1


def test_matcher_filecontains_gitignore(tmp_path):
    """secret_scanning via orFileContains on .gitignore."""
    yes = _repo(tmp_path / "y", {".gitignore": "node_modules\n.env\n"})
    no = _repo(tmp_path / "n", {".gitignore": "node_modules\n"})
    assert score_readiness(yes)["readiness_pillars"]["security"]["passed"] == 1
    assert score_readiness(no)["readiness_pillars"]["security"]["passed"] == 0


# ── level algorithm (exact, unambiguous) ─────────────────────────────────────────────────

def test_level_L0_bare_repo(tmp_path):
    r = score_readiness(_repo(tmp_path, {"notes.md": "nothing matches"}))
    assert r["readiness_level"] == "L0"
    assert r["readiness_pct"] == 0.0


def test_level_L1_readme_and_manifest(tmp_path):
    r = score_readiness(_repo(tmp_path, {"README.md": "# x", "package.json": "{}"}))
    assert r["readiness_level"] == "L1"          # L1 2/2; ≤L2 2/7 < 0.8
    assert r["readiness_pct"] == round(100 * 2 / 18, 2)  # 11.11


def test_level_L2_exact(tmp_path):
    r = score_readiness(_repo(tmp_path, {
        "README.md": "# x",
        "package.json": "{}",
        "CLAUDE.md": "x" * 500,          # present + nontrivial
        ".eslintrc.json": "{}",          # linter
        "tests/test_x.py": "def test_x(): pass",  # tests_present
    }))
    assert r["readiness_level"] == "L2"          # ≤L2 6/7 ≥ 0.8; ≤L3 6/12 < 0.8
    assert r["readiness_pct"] == round(100 * 6 / 18, 2)  # 33.33


def test_verification_cap_to_L3(tmp_path):
    """16 non-testing checks pass, 0 testing → raw rate reaches L5 but caps at L3."""
    r = score_readiness(_repo(tmp_path, _ALL_BUT_TESTING))
    assert r["readiness_pillars"]["testing"]["passed"] == 0
    assert r["readiness_level"] == "L3"          # capped (would be L5 uncapped)


def test_pillars_shape_matches_brain_contract(tmp_path):
    r = score_readiness(_repo(tmp_path, _ALL_BUT_TESTING))
    pillars = r["readiness_pillars"]
    assert len(pillars) == 9
    assert sum(p["total"] for p in pillars.values()) == 18
    for p in pillars.values():
        assert 0 <= p["passed"] <= p["total"]    # brain's passed<=total refine
    assert r["readiness_level"] in {"L0", "L1", "L2", "L3", "L4", "L5"}
    assert r["readiness_rubric_version"] == "1.0.0"


# ── failure + safety paths ───────────────────────────────────────────────────────────────

def test_missing_rubric_returns_none(tmp_path):
    assert score_readiness(_repo(tmp_path, {"README.md": "x"}), rubric_path="/no/such.json") is None


def test_analyze_repo_survives_rubric_failure(tmp_path):
    """Loader failure → score None → analyze_repo still emits the schema-safe null shape."""
    repo = _repo(tmp_path, {"README.md": "x", "package.json": "{}"})
    payload = analyze_repo(str(repo), slug="x", rubric_path="/no/such.json")
    m = payload["metrics"]
    assert m["readiness_level"] is None
    assert m["readiness_pct"] is None
    assert m["readiness_pillars"] == {}          # NOT null — schema default
    assert m["readiness_rubric_version"] is None


def test_safe_rel_rejects_traversal():
    assert _safe_rel("CLAUDE.md") == "CLAUDE.md"
    assert _safe_rel("../../etc/passwd") is None
    assert _safe_rel("/etc/passwd") is None
    assert _safe_rel("a/../../b") is None


def test_tracked_symlink_cannot_escape_repo(tmp_path):
    """A COMMITTED symlink pointing outside the repo must not let a size/content check read
    the external file. Regression for the PR #28 review finding: a CLAUDE.md symlink to an
    external >=400-byte file wrongly counted as non-trivial agent instructions."""
    outside = tmp_path / "outside-secret.txt"
    outside.write_text("x" * 800)  # big enough to trip nontrivial (>=400) + nothing else

    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "CLAUDE.md").symlink_to(outside)  # tracked symlink escaping the repo
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True, env=_ENV)
    subprocess.run(["git", "branch", "-m", "main"], cwd=repo, check=True, env=_ENV)
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True, env=_ENV)
    subprocess.run(["git", "commit", "-qm", "seed"], cwd=repo, check=True, env=_ENV)

    ai = score_readiness(repo)["readiness_pillars"]["agent_instructions"]
    # present (existence, no read) may pass; the size-based checks (nontrivial, compounding)
    # must NOT read the external file — so passed is 1, never 2+.
    assert ai["passed"] == 1


def test_path_escape_via_override_rubric(tmp_path, capsys):
    """A malicious override rubric pointing outside the repo reads nothing → check fails,
    scorer still returns a valid result (does not crash, does not probe the host)."""
    repo = _repo(tmp_path, {"README.md": "x"})
    rubric = {
        "version": "evil", "advanceThreshold": 0.8,
        "verificationCapLevel": 3, "verificationCapPillar": "testing",
        "levels": [{"id": "L1"}],
        "pillars": [{"key": "security", "title": "s"}],
        "checks": [{
            "id": "leak", "pillar": "security", "level": "L1",
            "signal": {"fileMinBytes": {"anyOf": ["../../../../../etc/passwd"], "bytes": 1}},
        }],
    }
    rp = tmp_path / "evil.json"
    rp.write_text(json.dumps(rubric), encoding="utf-8")
    r = score_readiness(repo, rubric_path=str(rp))
    assert r is not None
    assert r["readiness_pillars"]["security"] == {"passed": 0, "total": 1}
    assert r["readiness_level"] == "L0"


# ── package data ─────────────────────────────────────────────────────────────────────────

def test_vendored_rubric_loads_as_package_data():
    """Proves importlib.resources can read the rubric from the installed package, not just
    the source tree — guards against a wheel that drops the .json."""
    from importlib import resources

    res = resources.files("aios_ingest.rubric") / "agent-readiness.json"
    data = json.loads(res.read_text(encoding="utf-8"))
    assert data["version"] == "1.0.0"
    assert len(data["checks"]) == 18
