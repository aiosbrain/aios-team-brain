"""Codebase analyzer — RAW metrics from a local git checkout (+ optional GitHub API).

Produces the payload for POST /api/v1/codebases. With ONE deliberate exception
(``readiness`` — see below) it computes no scores; the brain derives ``agentic_score`` /
``health_score`` from these raw inputs (one scoring implementation, unit-tested in TS). The
key AI-transformation signal is the ``Co-Authored-By: Claude`` commit trailer — treated
as a heuristic for AI-*assisted* commits, not exact AI-authored lines.

**The readiness exception:** AEM agent-readiness is scored HERE (``analyzers/readiness.py``)
against the vendored rubric, because its checks are filesystem questions only the scanner can
answer (the brain has no repo access). The brain persists the result verbatim. See
``docs/ARCHITECTURE.md`` and the pinned contract ``aios-workspace/docs/brain-api.md``.

Pure local-git operation needs no network. If ``full_name`` + a GitHub token are given,
repo metadata (stars/forks/languages) and issues/PRs are enriched best-effort.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .readiness import score_readiness

log = logging.getLogger(__name__)

# unit/record separators that won't appear in commit metadata
_RS = "\x1e"
_FS = "\x1f"
_AI_TRAILER = re.compile(r"co-authored-by:\s*claude", re.IGNORECASE)
_CODE_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php",
    ".c", ".h", ".cpp", ".cs", ".sql", ".sh", ".mjs", ".cjs", ".svelte", ".vue",
}
_MAX_FILE_BYTES = 1_000_000  # skip giant/generated files when counting LOC
_MAX_ISSUE_PAGES = 10  # GitHub issues pagination cap (1000 issues); logged if hit
_MAX_BACKFILL_POINTS = 60  # bound on historical trend points per scan


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


def _analyze_git(
    repo: Path,
    window_days: int,
    *,
    ref: str = "HEAD",
    since_iso: str | None = None,
    as_of: datetime | None = None,
) -> dict[str, Any]:
    """Parse `git log` over the window into per-author/day rollups + window totals.

    For a historical snapshot pass `ref=<sha>` (the tip at that point), `since_iso`
    (absolute window start) and `as_of` (the snapshot date, for cadence freshness).
    """
    since = f"--since={since_iso}" if since_iso else f"--since={window_days}.days.ago"
    fmt = f"tformat:{_RS}%H{_FS}%an{_FS}%ae{_FS}%aI{_FS}%B{_FS}"
    raw = _git(repo, "log", ref, since, "--no-merges", f"--pretty={fmt}", "--numstat")

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
                "sha": sha[:10], "author": name, "author_email": email, "ai": ai,
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
        ref_now = as_of or datetime.now(timezone.utc)
        days_since_last = max(0, (ref_now - last_dt).days)

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


def _entries_under(tracked: list[str], subdir: str) -> set[str]:
    """Top-level entry names directly under any `.claude/<subdir>/` directory.

    Handles both a root-level `.claude/skills/foo/...` and a nested
    `pkg/.claude/skills/foo` — `str.find` locates the marker wherever it sits, so
    a root path (index 0) no longer trips the leading-slash assumption that the
    earlier split-based logic crashed on.
    """
    marker = f".claude/{subdir}/"
    skip = {"readme.md", "index.md"}  # documentation, not a skill/command
    names: set[str] = set()
    for f in tracked:
        idx = f.find(marker)
        if idx == -1:
            continue
        rest = f[idx + len(marker):]
        head = rest.split("/", 1)[0]
        if head and head.lower() not in skip:
            names.add(head)
    return names


def _detect_scaffolding(repo: Path) -> dict[str, Any]:
    tracked = _git(repo, "ls-files").splitlines()
    # Match the AGENTS.md basename only — `endswith` would catch e.g. managed-agents.md.
    agents = [f for f in tracked if Path(f).name.lower() == "agents.md"]
    return {
        "has_claude_md": (repo / "CLAUDE.md").is_file(),
        "has_agents_md": len(agents) > 0,
        "agents_md_count": len(agents),
        "skills_count": len(_entries_under(tracked, "skills")),
        "commands_count": len(_entries_under(tracked, "commands")),
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


def _read_coverage(repo: Path) -> dict[str, float | None]:
    """Read a committed coverage report if present (Istanbul json or lcov).

    Returns {"lines", "functions", "branches"} percentages, each None when that
    dimension isn't reported (or no report exists at all). `lines` is the headline
    number; functions/branches are surfaced alongside it on the dashboard.
    """
    import json

    empty: dict[str, float | None] = {"lines": None, "functions": None, "branches": None}

    for rel in ("coverage/coverage-summary.json", "coverage-summary.json"):
        p = repo / rel
        if p.is_file():
            try:
                total = json.loads(p.read_text()).get("total", {})

                def _pct(key: str) -> float | None:
                    v = total.get(key, {}).get("pct")
                    return float(v) if isinstance(v, (int, float)) else None

                if _pct("lines") is not None:
                    return {"lines": _pct("lines"), "functions": _pct("functions"), "branches": _pct("branches")}
            except (ValueError, OSError):
                pass

    lcov = repo / "coverage" / "lcov.info"
    if lcov.is_file():
        try:
            # [hit, found] per dimension: L=lines, FN=functions, BR=branches.
            counts = {"L": [0, 0], "FN": [0, 0], "BR": [0, 0]}
            for line in lcov.read_text().splitlines():
                if line.startswith("LH:"):
                    counts["L"][0] += int(line[3:])
                elif line.startswith("LF:"):
                    counts["L"][1] += int(line[3:])
                elif line.startswith("FNH:"):
                    counts["FN"][0] += int(line[4:])
                elif line.startswith("FNF:"):
                    counts["FN"][1] += int(line[4:])
                elif line.startswith("BRH:"):
                    counts["BR"][0] += int(line[4:])
                elif line.startswith("BRF:"):
                    counts["BR"][1] += int(line[4:])

            def _ratio(k: str) -> float | None:
                hit, found = counts[k]
                return round(100 * hit / found, 2) if found else None

            if counts["L"][1]:  # lines found → a real report
                return {"lines": _ratio("L"), "functions": _ratio("FN"), "branches": _ratio("BR")}
        except (ValueError, OSError):
            pass
    return empty


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

            # Paginate so we don't silently truncate repos with >100 issues/PRs.
            # Cap at _MAX_ISSUE_PAGES (logged) to bound API calls on huge repos.
            issues: list[dict[str, Any]] = []
            for page in range(1, _MAX_ISSUE_PAGES + 1):
                batch = gh.get(
                    f"https://api.github.com/repos/{full_name}/issues",
                    params={"state": "all", "per_page": 100, "page": page},
                ).json()
                if not isinstance(batch, list) or not batch:
                    break
                for it in batch:
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
                if len(batch) < 100:
                    break
            else:
                log.warning(
                    "issues truncated at %d pages (%d issues) for %s",
                    _MAX_ISSUE_PAGES, len(issues), full_name,
                )
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
    rubric_path: str | None = None,
) -> dict[str, Any]:
    """Build the codebase scan payload from a local checkout. Raw metrics, plus scanner-side
    AEM agent-readiness (the one computed score; ``rubric_path`` overrides the vendored rubric)."""
    repo = Path(path).resolve()
    if not (repo / ".git").exists():
        raise ValueError(f"{repo} is not a git repository")

    git = _analyze_git(repo, window_days)
    scaff = _detect_scaffolding(repo)
    coverage = _read_coverage(repo)
    readiness = score_readiness(repo, rubric_path)
    gh = _github_enrich(full_name, github_token or os.environ.get("GITHUB_TOKEN"))
    meta = gh.get("meta", {})

    return {
        "codebase": _codebase_block(slug, full_name, meta),
        "metrics": _metrics_block(git, scaff, coverage, _head_sha(repo), window_days, readiness=readiness),
        "contributions": git["contributions"],
        "issues": gh.get("issues", []),
    }


def _codebase_block(slug: str, full_name: str, meta: dict[str, Any]) -> dict[str, Any]:
    return {
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


def _metrics_block(
    git: dict[str, Any],
    scaff: dict[str, Any],
    coverage: dict[str, float | None] | None,
    head_sha: str,
    window_days: int,
    scanned_at: str | None = None,
    readiness: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # Single normalizer for the readiness fields: a scored dict OR None (scorer failure /
    # historical backfill) both yield the brain's schema-safe shape — level/pct/version
    # nullable, pillars defaults to {} (NOT nullable). Keeps the two paths byte-identical.
    r = readiness or {}
    c = coverage or {}  # history backfill passes None (no coverage at past SHAs)
    block = {
        "head_sha": head_sha,
        "window_days": window_days,
        "loc": scaff["loc"],
        "files": scaff["files"],
        "commits_window": git["commits_window"],
        "ai_commits_window": git["ai_commits_window"],
        "additions_window": git["additions_window"],
        "deletions_window": git["deletions_window"],
        "test_coverage_pct": c.get("lines"),
        "test_coverage_functions_pct": c.get("functions"),
        "test_coverage_branches_pct": c.get("branches"),
        "recent_commits": git["recent_commits"],
        "has_claude_md": scaff["has_claude_md"],
        "has_agents_md": scaff["has_agents_md"],
        "agents_md_count": scaff["agents_md_count"],
        "skills_count": scaff["skills_count"],
        "commands_count": scaff["commands_count"],
        "active_days": git["active_days"],
        "days_since_last_commit": git["days_since_last_commit"],
        "readiness_level": r.get("readiness_level"),
        "readiness_pct": r.get("readiness_pct"),
        "readiness_pillars": r.get("readiness_pillars", {}),
        "readiness_rubric_version": r.get("readiness_rubric_version"),
    }
    if scanned_at:
        block["scanned_at"] = scanned_at  # historical snapshots set their as-of date
    return block


def _scaffolding_at(repo: Path, sha: str) -> dict[str, Any]:
    """Read scaffolding at a past commit via a throwaway worktree (non-destructive —
    never touches the live working tree or HEAD)."""
    import tempfile

    with tempfile.TemporaryDirectory(prefix="aios-wt-") as tmp:
        try:
            _git(repo, "worktree", "add", "--detach", "--quiet", tmp, sha)
        except subprocess.CalledProcessError:
            return _detect_scaffolding(repo)  # fall back to current if checkout fails
        try:
            return _detect_scaffolding(Path(tmp))
        finally:
            _git(repo, "worktree", "remove", "--force", tmp)


def analyze_history(
    path: str,
    *,
    slug: str,
    full_name: str = "",
    window_days: int = 90,
    weeks: int = 12,
    github_token: str | None = None,
) -> list[dict[str, Any]]:
    """Emit one scan payload per DISTINCT historical HEAD over the past `weeks` weeks —
    for the trend chart. Samples DAILY (so a young-but-active repo still gets multiple
    points) and dedupes by SHA, so the result is one point per distinct code state.
    Idempotent on the brain side (unique on codebase_id, head_sha). Git metrics +
    scaffolding are computed at each historical commit; coverage is null for the past
    (reports aren't committed). Capped at _MAX_BACKFILL_POINTS."""
    repo = Path(path).resolve()
    if not (repo / ".git").exists():
        raise ValueError(f"{repo} is not a git repository")
    branch = _git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip() or "HEAD"
    gh = _github_enrich(full_name, github_token or os.environ.get("GITHUB_TOKEN"))
    meta = gh.get("meta", {})
    codebase = _codebase_block(slug, full_name, meta)

    now = datetime.now(timezone.utc)
    seen: set[str] = set()
    payloads: list[dict[str, Any]] = []
    for d in range(weeks * 7 + 1):
        if len(payloads) >= _MAX_BACKFILL_POINTS:
            break
        before = (now - timedelta(days=d)).date().isoformat()
        try:
            sha = _git(repo, "rev-list", "-1", f"--before={before}", branch).strip()
        except subprocess.CalledProcessError:
            continue
        if not sha or sha in seen:
            continue
        seen.add(sha)
        sha_iso = _git(repo, "show", "-s", "--format=%aI", sha).strip()
        try:
            sha_dt = datetime.fromisoformat(sha_iso)
        except ValueError:
            sha_dt = now
        since_iso = (sha_dt - timedelta(days=window_days)).date().isoformat()
        git = _analyze_git(repo, window_days, ref=sha, since_iso=since_iso, as_of=sha_dt)
        scaff = _scaffolding_at(repo, sha)
        payloads.append({
            "codebase": codebase,
            "metrics": _metrics_block(git, scaff, None, sha, window_days, scanned_at=sha_iso),
            "contributions": git["contributions"],
            "issues": [],  # issues are point-in-time; only the live scan syncs them
        })
    return payloads
