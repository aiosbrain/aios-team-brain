"""Codebase analyzer — RAW metrics from a local git checkout (+ optional GitHub API).

Produces the payload for POST /api/v1/codebases. It NEVER computes scores; the brain
does that from these raw inputs (one scoring implementation, unit-tested in TS). The
key AI-transformation signal is the ``Co-Authored-By: Claude`` commit trailer — treated
as a heuristic for AI-*assisted* commits, not exact AI-authored lines.

Pure local-git operation needs no network. If ``full_name`` + a GitHub token are given,
repo metadata (stars/forks/languages) and issues/PRs are enriched best-effort.
"""

from __future__ import annotations

import os
import re
import subprocess
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# unit/record separators that won't appear in commit metadata
_RS = "\x1e"
_FS = "\x1f"
_AI_TRAILER = re.compile(r"co-authored-by:\s*claude", re.IGNORECASE)
_CODE_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php",
    ".c", ".h", ".cpp", ".cs", ".sql", ".sh", ".mjs", ".cjs", ".svelte", ".vue",
}
_MAX_FILE_BYTES = 1_000_000  # skip giant/generated files when counting LOC


def _git(repo: Path, *args: str) -> str:
    out = subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, check=True
    )
    return out.stdout


def _head_sha(repo: Path) -> str:
    try:
        return _git(repo, "rev-parse", "HEAD").strip()
    except subprocess.CalledProcessError:
        return ""


def _author_key(name: str, email: str) -> str:
    return (email or name).strip().lower()


def _analyze_git(repo: Path, window_days: int) -> dict[str, Any]:
    """Parse `git log` over the window into per-author/day rollups + window totals."""
    since = f"--since={window_days}.days.ago"
    fmt = f"tformat:{_RS}%H{_FS}%an{_FS}%ae{_FS}%aI{_FS}%B{_FS}"
    raw = _git(repo, "log", since, "--no-merges", f"--pretty={fmt}", "--numstat")

    contribs: dict[tuple[str, str], dict[str, Any]] = defaultdict(
        lambda: {"author_name": "", "author_email": "", "commits": 0, "ai_commits": 0,
                 "additions": 0, "deletions": 0}
    )
    days: set[str] = set()
    recent: list[dict[str, Any]] = []
    totals = {"commits": 0, "ai_commits": 0, "additions": 0, "deletions": 0}
    last_dt: datetime | None = None

    for chunk in raw.split(_RS):
        chunk = chunk.strip("\n")
        if not chunk:
            continue
        parts = chunk.split(_FS)
        if len(parts) < 5:
            continue
        sha, name, email, iso, body = parts[0], parts[1], parts[2], parts[3], parts[4]
        numstat = parts[5] if len(parts) > 5 else ""

        try:
            dt = datetime.fromisoformat(iso)
        except ValueError:
            continue
        day = iso[:10]
        ai = bool(_AI_TRAILER.search(body))

        adds = dels = 0
        for line in numstat.splitlines():
            cols = line.split("\t")
            if len(cols) >= 2:
                a, d = cols[0], cols[1]
                adds += int(a) if a.isdigit() else 0
                dels += int(d) if d.isdigit() else 0

        key = (_author_key(name, email), day)
        c = contribs[key]
        c["author_name"] = c["author_name"] or name
        c["author_email"] = c["author_email"] or email
        c["commits"] += 1
        c["ai_commits"] += 1 if ai else 0
        c["additions"] += adds
        c["deletions"] += dels

        days.add(day)
        totals["commits"] += 1
        totals["ai_commits"] += 1 if ai else 0
        totals["additions"] += adds
        totals["deletions"] += dels
        if last_dt is None or dt > last_dt:
            last_dt = dt
        if len(recent) < 20:
            recent.append({
                "sha": sha[:10], "author": name, "ai": ai,
                "additions": adds, "deletions": dels,
                "committed_at": iso, "message": body.splitlines()[0] if body else "",
            })

    contributions = [
        {
            "author_key": k[0],
            "author_name": v["author_name"],
            "author_email": v["author_email"],
            "day": k[1],
            "commits": v["commits"],
            "ai_commits": v["ai_commits"],
            "additions": v["additions"],
            "deletions": v["deletions"],
        }
        for k, v in contribs.items()
    ]

    days_since_last = None
    if last_dt is not None:
        days_since_last = max(0, (datetime.now(timezone.utc) - last_dt).days)

    return {
        "commits_window": totals["commits"],
        "ai_commits_window": totals["ai_commits"],
        "additions_window": totals["additions"],
        "deletions_window": totals["deletions"],
        "active_days": len(days),
        "days_since_last_commit": days_since_last,
        "recent_commits": recent,
        "contributions": contributions,
    }


def _detect_scaffolding(repo: Path) -> dict[str, Any]:
    tracked = _git(repo, "ls-files").splitlines()
    agents = [f for f in tracked if f.lower().endswith("agents.md")]
    skills = {f.split("/.claude/skills/")[1].split("/")[0]
              for f in tracked if "/.claude/skills/" in f or f.startswith(".claude/skills/")}
    skills |= {f.split(".claude/skills/")[1].split("/")[0]
               for f in tracked if f.startswith(".claude/skills/")}
    commands = [f for f in tracked
                if f.startswith(".claude/commands/") or "/.claude/commands/" in f]
    return {
        "has_claude_md": (repo / "CLAUDE.md").is_file(),
        "has_agents_md": len(agents) > 0,
        "agents_md_count": len(agents),
        "skills_count": len({s for s in skills if s}),
        "commands_count": len(commands),
        "files": len(tracked),
        "loc": _count_loc(repo, tracked),
    }


def _count_loc(repo: Path, tracked: list[str]) -> int:
    loc = 0
    for rel in tracked:
        if Path(rel).suffix.lower() not in _CODE_EXT:
            continue
        p = repo / rel
        try:
            if p.stat().st_size > _MAX_FILE_BYTES:
                continue
            with open(p, "rb") as fh:
                loc += sum(1 for _ in fh)
        except OSError:
            continue
    return loc


def _read_coverage(repo: Path) -> float | None:
    """Read a committed coverage report if present (Istanbul json or lcov). Else None."""
    import json

    for rel in ("coverage/coverage-summary.json", "coverage-summary.json"):
        p = repo / rel
        if p.is_file():
            try:
                data = json.loads(p.read_text())
                pct = data.get("total", {}).get("lines", {}).get("pct")
                if isinstance(pct, (int, float)):
                    return float(pct)
            except (ValueError, OSError):
                pass

    lcov = repo / "coverage" / "lcov.info"
    if lcov.is_file():
        try:
            hit = found = 0
            for line in lcov.read_text().splitlines():
                if line.startswith("LH:"):
                    hit += int(line[3:])
                elif line.startswith("LF:"):
                    found += int(line[3:])
            if found:
                return round(100 * hit / found, 2)
        except (ValueError, OSError):
            pass
    return None


def _github_enrich(full_name: str, token: str | None) -> dict[str, Any]:
    """Best-effort repo metadata + issues from the GitHub REST API."""
    if not full_name or not token:
        return {}
    import httpx

    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}
    out: dict[str, Any] = {}
    try:
        with httpx.Client(timeout=20.0, headers=headers) as gh:
            repo = gh.get(f"https://api.github.com/repos/{full_name}").json()
            out["meta"] = {
                "stars": repo.get("stargazers_count", 0),
                "forks": repo.get("forks_count", 0),
                "open_issues": repo.get("open_issues_count", 0),
                "primary_language": repo.get("language") or "",
                "default_branch": repo.get("default_branch", "main"),
                "description": (repo.get("description") or "")[:2000],
                "homepage": repo.get("homepage") or "",
            }
            langs = gh.get(f"https://api.github.com/repos/{full_name}/languages").json()
            out["meta"]["languages"] = langs if isinstance(langs, dict) else {}

            issues_resp = gh.get(
                f"https://api.github.com/repos/{full_name}/issues",
                params={"state": "all", "per_page": 100},
            ).json()
            issues = []
            for it in issues_resp if isinstance(issues_resp, list) else []:
                issues.append({
                    "number": it["number"],
                    "title": (it.get("title") or "")[:1000],
                    "state": it.get("state", "open"),
                    "is_pull_request": "pull_request" in it,
                    "author_login": (it.get("user") or {}).get("login", ""),
                    "assignee_login": (it.get("assignee") or {}).get("login", "") or "",
                    "labels": [lb["name"] for lb in it.get("labels", []) if isinstance(lb, dict)],
                    "comments": it.get("comments", 0),
                    "url": it.get("html_url", ""),
                    "opened_at": it.get("created_at"),
                    "closed_at": it.get("closed_at"),
                })
            out["issues"] = issues
    except Exception:  # noqa: BLE001 — enrichment is best-effort; local git still wins
        return {}
    return out


def analyze_repo(
    path: str,
    *,
    slug: str,
    full_name: str = "",
    window_days: int = 90,
    github_token: str | None = None,
) -> dict[str, Any]:
    """Build the codebase scan payload (RAW metrics only) from a local checkout."""
    repo = Path(path).resolve()
    if not (repo / ".git").exists():
        raise ValueError(f"{repo} is not a git repository")

    git = _analyze_git(repo, window_days)
    scaff = _detect_scaffolding(repo)
    coverage = _read_coverage(repo)
    gh = _github_enrich(full_name, github_token or os.environ.get("GITHUB_TOKEN"))
    meta = gh.get("meta", {})

    codebase = {
        "slug": slug,
        "full_name": full_name,
        "default_branch": meta.get("default_branch", "main"),
        "description": meta.get("description", ""),
        "homepage": meta.get("homepage", ""),
        "primary_language": meta.get("primary_language", ""),
        "languages": meta.get("languages", {}),
        "stars": meta.get("stars", 0),
        "forks": meta.get("forks", 0),
        "open_issues": meta.get("open_issues", 0),
    }
    metrics = {
        "head_sha": _head_sha(repo),
        "window_days": window_days,
        "loc": scaff["loc"],
        "files": scaff["files"],
        "commits_window": git["commits_window"],
        "ai_commits_window": git["ai_commits_window"],
        "additions_window": git["additions_window"],
        "deletions_window": git["deletions_window"],
        "test_coverage_pct": coverage,
        "recent_commits": git["recent_commits"],
        "has_claude_md": scaff["has_claude_md"],
        "has_agents_md": scaff["has_agents_md"],
        "agents_md_count": scaff["agents_md_count"],
        "skills_count": scaff["skills_count"],
        "commands_count": scaff["commands_count"],
        "active_days": git["active_days"],
        "days_since_last_commit": git["days_since_last_commit"],
    }
    return {
        "codebase": codebase,
        "metrics": metrics,
        "contributions": git["contributions"],
        "issues": gh.get("issues", []),
    }
