"""Codebase analyzer — RAW metrics from a local git checkout (+ optional GitHub API).

Produces the payload for POST /api/v1/codebases. With ONE deliberate exception
(``readiness`` — see below) it computes no scores; the brain derives ``agentic_score`` /
``health_score`` from these raw inputs (one scoring implementation, unit-tested in TS). The
key AI-transformation signal is a ``Co-Authored-By: <tool>`` commit trailer (Claude, Codex,
Cursor, OpenCode, GitHub Copilot, Devin — see ``_AI_TRAILER`` below) or a generated-with
banner — treated as a heuristic for AI-*assisted* commits, not exact AI-authored lines.

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
from pathlib import Path, PurePosixPath
from typing import Any

from .readiness import score_readiness

log = logging.getLogger(__name__)

# unit/record separators that won't appear in commit metadata
_RS = "\x1e"
_FS = "\x1f"
# Commit-message markers left by AI coding agents (case-insensitive). Mirrors
# lib/codebases/github-api-scan.ts's AI_MARKERS — keep both in sync; the shared
# fixture at test/fixtures/ai-trailer-cases.json pins every case both sides must pass.
_AI_TRAILER = re.compile(
    r"co-authored-by:\s*(claude|codex|cursor|opencode|github copilot|devin)\b"
    r"|generated with \[claude code\]"
    r"|🤖 generated with",
    re.IGNORECASE,
)
_CODE_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php",
    ".c", ".h", ".cpp", ".cs", ".sql", ".sh", ".mjs", ".cjs", ".svelte", ".vue",
}
_MAX_FILE_BYTES = 1_000_000  # skip giant/generated files when counting LOC
_MAX_ISSUE_PAGES = 10  # GitHub issues pagination cap (1000 issues); logged if hit
_MAX_BACKFILL_POINTS = 60  # bound on historical trend points per scan


def _git(repo: Path, *args: str) -> str:
    """Run git in `repo` and return stdout.

    `errors="surrogateescape"` because a filename is a byte string, not text: git
    happily indexes a path that is not valid UTF-8, and once `core.quotePath=false`
    stops C-quoting the stream (see `_tracked_entries`), strict decoding would raise
    `UnicodeDecodeError` and abort the WHOLE scan over one undecodable name. Not
    `errors="replace"`: surrogates round-trip back to the filesystem, which
    `_count_loc`'s `open(repo / rel)` depends on.

    `GIT_NO_LAZY_FETCH=1` keeps a partial (`--filter=blob:none`) clone from turning
    an object read — `cat-file blob` on a symlink — into an unbounded network fetch
    inside the scanner.
    """
    out = subprocess.run(
        ["git", *args],
        cwd=repo,
        capture_output=True,
        check=True,
        encoding="utf-8",
        errors="surrogateescape",
        env={**os.environ, "GIT_NO_LAZY_FETCH": "1"},
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


_SKILL_MANIFEST = "skill.md"  # marker file that makes a directory a skill
_ENTRY_SKIP = {"readme.md", "index.md"}  # documentation, not a skill/command
_GIT_SYMLINK_MODE = "120000"


def _tracked_entries(repo: Path) -> list[tuple[str, str, str]]:
    """`(mode, object_sha, path)` for every tracked file.

    `-z` + `core.quotePath=false` because git otherwise C-quotes any path with a
    non-ASCII byte (`"skills/caf\303\251/SKILL.md"`, leading quote included), which
    silently breaks every prefix match downstream — a skill named in a non-Latin
    script would just not exist as far as this scanner is concerned.
    """
    raw = _git(repo, "-c", "core.quotePath=false", "ls-files", "-sz")
    out: list[tuple[str, str, str]] = []
    for rec in raw.split("\0"):
        if not rec:
            continue
        meta, _, path = rec.partition("\t")
        cols = meta.split(" ")
        if not path or len(cols) < 2:
            continue
        out.append((cols[0], cols[1], path))
    return out


def _link_target(repo: Path, sha: str) -> str:
    """The path a tracked symlink points at — read from the git OBJECT, not the disk.

    A symlink's target is the blob's contents. Reading it from git rather than
    `os.readlink` makes this work on a checkout where git did not materialise the
    link at all: `core.symlinks=false` (git's DEFAULT on Windows without Developer
    Mode, and anything cloned with `-c core.symlinks=false`) writes the target path
    into a REGULAR FILE. A filesystem `is_symlink()` gate reads False there and the
    layout silently reverts to counting zero — the exact bug this arm exists to fix.
    """
    try:
        return _git(repo, "cat-file", "blob", sha).strip()
    except subprocess.CalledProcessError:
        return ""


def _resolve_in_repo(link_path: str, target: str) -> str | None:
    """Resolve a symlink target to a repo-relative path, or None if it escapes.

    Purely lexical — no filesystem access — so it behaves identically on a
    non-symlink checkout, and can't be fooled by the repo itself sitting under a
    symlinked parent (macOS `/tmp` → `/private/tmp`, which the historical-snapshot
    path in `_scaffolding_at` hits on every scan).

    An absolute target, or one that climbs above the repo root, returns None: a
    scanner must never follow a link out of the checkout it was handed.
    """
    if not target or target.startswith("/") or ":" in target.split("/", 1)[0]:
        return None  # absolute posix path, or a windows drive/UNC target
    parts: list[str] = []
    for seg in (PurePosixPath(link_path).parent / target).parts:
        if seg in ("", "."):
            continue
        if seg == "..":
            if not parts:
                return None  # climbed above the repo root
            parts.pop()
        else:
            parts.append(seg)
    return "/".join(parts) or None


def _heads_under(paths: list[str], prefix: str) -> set[str]:
    """First path segment of every tracked file under `prefix/`, docs excluded."""
    names: set[str] = set()
    marker = prefix.rstrip("/") + "/"
    for f in paths:
        if not f.startswith(marker):
            continue
        head = f[len(marker):].split("/", 1)[0]
        if head and head.lower() not in _ENTRY_SKIP:
            names.add(head)
    return names


def _is_pack_root(top: str) -> bool:
    """Is a top-level directory name a plausible skill-pack root?

    `skills/` or `<something>-skills/` only. Deliberately narrow: see arm 3.
    """
    low = top.lower()
    return low == "skills" or low.endswith("-skills")


def _entries_under(
    entries: list[tuple[str, str, str]], repo: Path, subdir: str
) -> set[str]:
    """Names of the skills/commands a repo ships, across the three real layouts.

    Returns entry NAMES, never paths, and that is load-bearing: a symlinked
    `.claude/skills` and its target both resolve to the same names, so the set
    dedupes them for free. Counting paths (or summing per-layout counts) would
    double-count `aios-marketing`, where `.claude/skills` → `.agents/skills` and
    BOTH are visible to `git ls-files`. It also preserves the pre-existing collapse
    of a root and a nested skill sharing a name (`aios-workspace` ships `evolve`
    both at the root and under `scaffold/`) — widening that is a separate decision,
    and it is what holds that repo at its existing 50 rather than moving it to 52.

    The three layouts:

    1. **Plain** — `.claude/<subdir>/<name>/...`, at the root or nested under a
       package (`str.find` locates the marker wherever it sits).
    2. **Symlinked dir** — `.claude/skills` is a symlink to an in-tree directory
       (`aios-marketing` points it at `.agents/skills`). `git ls-files` emits the
       symlink as ONE entry with no trailing path, so a prefix match never fires;
       we read the link target out of its git blob and enumerate the tracked files
       under it. A target escaping the checkout is ignored (`_resolve_in_repo`).
    3. **Pack source** — `skills/**/<name>/SKILL.md` (or `<x>-skills/...`) at the
       repo ROOT, for repos that ARE the skill pack (`aios-engineering-harness`);
       those skills are deliberately not under `.claude/`. The skill is the directory
       holding the manifest, so a CATEGORISED pack (`skills/comms/slack-cli/`) counts
       its skills rather than its categories.

    **Arms 1 and 2 need no `SKILL.md` marker; arm 3 does.** That asymmetry is the
    point, not an oversight: `.claude/skills` is a *declaration* — the repo has said
    that directory holds its skills, whether the entries are stored there or linked
    in — whereas a bare `skills/` is an *inference*, and the marker is the only thing
    separating a real pack from an ordinary source directory. The root restriction
    does the same job one level up: across ~40 local repos, allowing nested pack
    roots would have counted `test/skill-scan-fixtures`, `gui/server`, and vendored
    `plugins/*` as shipped skills.

    Known under-count, accepted deliberately: a `SKILL.md` outside a recognised
    skills root is not counted (`aios-engineering-harness` keeps 3 more under
    `modules/`). The marker alone cannot tell a shipped skill from a test fixture or
    a vendored plugin, and the false positives that rule buys are worse than the miss.
    """
    paths = [p for _, _, p in entries]
    marker = f".claude/{subdir}/"
    names: set[str] = set()

    # (1) plain — a tracked file somewhere under `.claude/<subdir>/`
    for f in paths:
        idx = f.find(marker)
        if idx == -1:
            continue
        head = f[idx + len(marker):].split("/", 1)[0]
        if head and head.lower() not in _ENTRY_SKIP:
            names.add(head)

    # (2) symlinked `.claude/<subdir>` — one tracked entry, no trailing path
    link = f".claude/{subdir}"
    for mode, sha, f in entries:
        if mode != _GIT_SYMLINK_MODE:
            continue
        if f != link and not f.endswith(f"/{link}"):
            continue
        target = _resolve_in_repo(f, _link_target(repo, sha))
        if not target or target == f:
            continue
        names |= _heads_under(paths, target)

    # (3) pack source — `<pack-root>/**/<name>/SKILL.md` at the repo root
    if subdir == "skills":
        for f in paths:
            parts = f.split("/")
            if len(parts) < 3 or parts[-1].lower() != _SKILL_MANIFEST:
                continue
            if _is_pack_root(parts[0]):
                # The skill is the directory HOLDING the manifest, which is not
                # necessarily the second segment: a pack root may be CATEGORISED
                # (`optional-skills/comms/slack-cli/SKILL.md`). Keying on segment 2
                # there reports the number of categories under a field labelled a
                # skill count — hermes-agent read 26 for 97 real skills.
                names.add(parts[-2])

    return names


def _detect_scaffolding(repo: Path) -> dict[str, Any]:
    entries = _tracked_entries(repo)
    tracked = [p for _, _, p in entries]
    # Match the AGENTS.md basename only — `endswith` would catch e.g. managed-agents.md.
    agents = [f for f in tracked if Path(f).name.lower() == "agents.md"]
    return {
        "has_claude_md": (repo / "CLAUDE.md").is_file(),
        "has_agents_md": len(agents) > 0,
        "agents_md_count": len(agents),
        "skills_count": len(_entries_under(entries, repo, "skills")),
        "commands_count": len(_entries_under(entries, repo, "commands")),
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
    dimension isn't reported (or no report exists at all), plus ``lines_total`` /
    ``lines_covered`` — the COUNTS behind ``lines`` (brain-api 1.22, AIO-995).

    The counts are the denominator ``lines`` was measured over. Without them a report that
    instrumented 436 lines and one that instrumented 10,647 send an identical-looking
    percentage, and coverage carries 40% of the brain's ``health_score``. **LINES, not files,
    is the unit** for three reasons: both formats carry line counts natively in the totals they
    already parse below (Istanbul ``total.lines.total``/``.covered``; the ``LF:``/``LH:`` sums
    this function already accumulates), so nothing new is computed or globbed; the repo-side
    denominator the brain divides by (``loc``) is itself a line count, so the ratio is
    unit-consistent; and a file count would have to be compared against ``files``, which counts
    every tracked file — README, SVG, lockfile — and is therefore a different census entirely.

    Every value stays None when unreported. None means UNKNOWN all the way to the brain, which
    persists it as a null column: not zero instrumented lines, and not "the whole repo".
    """
    import json

    empty: dict[str, float | None] = {
        "lines": None,
        "functions": None,
        "branches": None,
        "lines_total": None,
        "lines_covered": None,
    }

    for rel in ("coverage/coverage-summary.json", "coverage-summary.json"):
        p = repo / rel
        if p.is_file():
            try:
                total = json.loads(p.read_text()).get("total", {})

                def _pct(key: str) -> float | None:
                    v = total.get(key, {}).get("pct")
                    return float(v) if isinstance(v, (int, float)) else None

                def _count(key: str) -> float | None:
                    v = total.get("lines", {}).get(key)
                    # bool is an int subclass — exclude it so a stray `true` isn't read as 1.
                    return int(v) if isinstance(v, int) and not isinstance(v, bool) else None

                if _pct("lines") is not None:
                    return {
                        "lines": _pct("lines"),
                        "functions": _pct("functions"),
                        "branches": _pct("branches"),
                        "lines_total": _count("total"),
                        "lines_covered": _count("covered"),
                    }
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
                return {
                    "lines": _ratio("L"),
                    "functions": _ratio("FN"),
                    "branches": _ratio("BR"),
                    # LF/LH are exactly the denominator and numerator of `lines` above — the
                    # same sums, now reported instead of divided away.
                    "lines_total": counts["L"][1],
                    "lines_covered": counts["L"][0],
                }
        except (ValueError, OSError):
            pass
    return empty


# Test-result reports the scanner will read, in preference order. Both are one reporter flag
# away in every runner this fleet uses, and neither is required — a repo with no report simply
# reports None (unknown), which is NOT the same as "nothing was skipped".
_TEST_REPORT_JSON = (
    "coverage/test-results.json",
    "test-results.json",
    "test-results/results.json",
)
_TEST_REPORT_JUNIT = (
    "coverage/junit.xml",
    "junit.xml",
    "test-results.xml",
    "test-results/junit.xml",
)


def _read_test_results(repo: Path) -> dict[str, int | None]:
    """Read a committed test-result report if present (Vitest/Jest JSON, or JUnit XML).

    Returns ``{"total", "passed", "skipped", "failed"}`` counts, each None when no report
    exists (brain-api 1.22, AIO-995).

    **Why this is worth a parser.** Skipped tests are not failures, so nothing goes red — but
    coverage moves anyway, and the number it lands on is perfectly plausible. On aios-devtools a
    single unset ``AIOS_TOOLKIT_DIR`` skipped 91 of 229 tests *by design* and swung coverage 29
    points (48.93% -> 77.68%); on aios-workspace-gui the same variable produced 27 failures plus
    58 skips, which would have wiped the report and left the dashboard reading "no report" while
    every gate stayed green. A degraded run has to announce itself.

    **None means UNKNOWN.** A repo that publishes no test-result report gets None, never 0 — the
    brain must not read "no report" as "nothing was skipped". Same rule as `_read_coverage`.
    """
    import json

    empty: dict[str, int | None] = {"total": None, "passed": None, "skipped": None, "failed": None}

    def _int(v: Any) -> int | None:
        return int(v) if isinstance(v, int) and not isinstance(v, bool) else None

    for rel in _TEST_REPORT_JSON:
        p = repo / rel
        if not p.is_file():
            continue
        try:
            doc = json.loads(p.read_text())
        except (ValueError, OSError):
            continue
        if not isinstance(doc, dict):
            continue
        total = _int(doc.get("numTotalTests"))
        if total is None:
            continue  # not a Vitest/Jest JSON report — keep looking
        return {
            "total": total,
            "passed": _int(doc.get("numPassedTests")),
            # Jest/Vitest split "not run" across pending (it.skip / it.todo).
            "skipped": _sum_or_none(_int(doc.get("numPendingTests")), _int(doc.get("numTodoTests"))),
            "failed": _int(doc.get("numFailedTests")),
        }

    # The input is a file the repo committed to its own tree, but it is still untrusted-shaped
    # input: a malformed document must fall through to "unknown", never raise out of a scan.
    import xml.etree.ElementTree as ET

    for rel in _TEST_REPORT_JUNIT:
        p = repo / rel
        if not p.is_file():
            continue
        try:
            root = ET.parse(p).getroot()
        except (ET.ParseError, OSError):
            continue
        # A JUnit file is either a single <testsuite> or a <testsuites> wrapper — and aggregated
        # files (Ant, some Karma/Gradle merges) NEST <testsuite> inside <testsuite>, with the
        # parent carrying rolled-up counts. Summing every descendant would count those tests
        # twice, inflating the totals and making a clean run report as partial. So sum LEAF
        # suites only: a suite that contains another <testsuite> is a rollup of the ones below it.
        all_suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
        suites = [s for s in all_suites if s.find("testsuite") is None]
        if not suites:
            continue
        agg = {"tests": 0, "skipped": 0, "failures": 0, "errors": 0}
        seen = False
        for suite in suites:
            if suite.get("tests") is None:
                continue
            seen = True
            for key in agg:
                try:
                    agg[key] += int(suite.get(key) or 0)
                except ValueError:
                    pass
        if not seen:
            continue
        # `errors` are counted as failures — a fixture/collection error is a case that did not
        # pass, and a scanner that dropped them would report a clean run for a broken one.
        failed = agg["failures"] + agg["errors"]
        # …but several runners count an error WITHOUT incrementing `tests` (pytest emits
        # `<testsuite tests="0" errors="1"/>` for a collection error). Taking `tests` at face
        # value there yields failed > total, which the brain rejects at the boundary — losing the
        # ENTIRE scan, contributions and issues included, over one degraded report. The total is
        # therefore at least the sum of its parts.
        total = max(agg["tests"], agg["skipped"] + failed)
        return {
            "total": total,
            "passed": max(0, total - agg["skipped"] - failed),
            "skipped": agg["skipped"],
            "failed": failed,
        }

    return empty


def _sum_or_none(*values: int | None) -> int | None:
    """Sum the values that were reported; None only when NONE of them were.

    A reporter that emits `numPendingTests` but not `numTodoTests` still knows something about
    skips, and that partial knowledge is worth more than discarding the field.
    """
    present = [v for v in values if v is not None]
    return sum(present) if present else None


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
    tests = _read_test_results(repo)
    readiness = score_readiness(repo, rubric_path)
    gh = _github_enrich(full_name, github_token or os.environ.get("GITHUB_TOKEN"))
    meta = gh.get("meta", {})

    return {
        "codebase": _codebase_block(slug, full_name, meta),
        "metrics": _metrics_block(
            git, scaff, coverage, _head_sha(repo), window_days, readiness=readiness, tests=tests
        ),
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


def _coherent_pair(total: int | None, part: int | None) -> tuple[int | None, int | None]:
    """Drop a numerator/denominator pair to UNKNOWN when the numerator doesn't fit inside it.

    The brain rejects an incoherent pair at the boundary (422) — and that 422 kills the WHOLE
    scan, contributions and GitHub issues included, not just the offending field. One malformed
    committed report would therefore take a repo's entire analytics offline, which is a worse
    version of the silent-degradation failure this feature exists to prevent.

    So the scanner never ships a pair it knows is wrong. Incoherent means the report was parsed
    wrong or written wrong; "we don't know" is the honest reading of that, and it is the one
    state the rest of this change is built to represent safely.
    """
    if total is not None and part is not None and part > total:
        return None, None
    return total, part


def _coherent_run(
    total: int | None, passed: int | None, skipped: int | None, failed: int | None
) -> tuple[int | None, int | None, int | None, int | None]:
    """Same rule for the test-run counts: any part exceeding the total voids the whole group.

    Voided as a GROUP rather than per-field, because the counts are only meaningful together —
    keeping `skipped` from a report whose `total` we just disbelieved would let the dashboard
    call a run partial on evidence we rejected.
    """
    parts = [p for p in (passed, skipped, failed) if p is not None]
    if total is not None and any(p > total for p in parts):
        return None, None, None, None
    return total, passed, skipped, failed


def _metrics_block(
    git: dict[str, Any],
    scaff: dict[str, Any],
    coverage: dict[str, float | None] | None,
    head_sha: str,
    window_days: int,
    scanned_at: str | None = None,
    readiness: dict[str, Any] | None = None,
    tests: dict[str, int | None] | None = None,
) -> dict[str, Any]:
    # Single normalizer for the readiness fields: a scored dict OR None (scorer failure /
    # historical backfill) both yield the brain's schema-safe shape — level/pct/version
    # nullable, pillars defaults to {} (NOT nullable). Keeps the two paths byte-identical.
    r = readiness or {}
    c = coverage or {}  # history backfill passes None (no coverage at past SHAs)
    # Same posture for the 1.22 run-integrity counts: a historical snapshot has no test-result
    # report either, and `.get` on {} yields None = unknown, which is exactly right.
    t = tests or {}
    cov_lines, cov_covered = _coherent_pair(c.get("lines_total"), c.get("lines_covered"))
    t_total, t_passed, t_skipped, t_failed = _coherent_run(
        t.get("total"), t.get("passed"), t.get("skipped"), t.get("failed")
    )
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
        # brain-api 1.22 (AIO-995) — the denominator behind test_coverage_pct, and whether the
        # run that produced it was complete. None = unknown; the brain stores it as a null
        # column and reads it as "no scope reported", never as zero.
        "test_coverage_lines_total": cov_lines,
        "test_coverage_lines_covered": cov_covered,
        "tests_total": t_total,
        "tests_passed": t_passed,
        "tests_skipped": t_skipped,
        "tests_failed": t_failed,
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
