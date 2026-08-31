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

import ast
import logging
import os
import re
import subprocess
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from ..build import scanner_sha, scanner_version
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
_MAX_FIX_PARENT_LINES = 10_000  # omit pathological analyses; coverage remains explicit
_CONVENTIONAL_SUBJECT = re.compile(r"^(?P<type>[A-Za-z]+)(?:\([^)]*\))?!?:")
_DIFF_OLD_PATH = re.compile(r"^--- (.+)$")
_DIFF_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@")
_BLAME_HEADER = re.compile(r"^\^?([0-9a-f]{40,64}) \d+ \d+(?: \d+)?$")
_FIX_AGE_BUCKETS = ("0_1d", "2_7d", "8_30d", "31_90d", "91_365d", "366d_plus")


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


def _classify_commit_subject(subject: str) -> dict[str, str]:
    """Classify a subject under the explicit Brain API 1.23 convention."""
    match = _CONVENTIONAL_SUBJECT.match(subject.strip())
    if not match:
        commit_type = "unparseable"
    else:
        conventional_type = match.group("type").lower()
        commit_type = conventional_type if conventional_type in {"fix", "feat"} else "other"
    return {"scheme": "conventional-commit-v1", "type": commit_type}


def _decode_diff_path(raw: str) -> str | None:
    """Decode git's old-side patch path without ever exposing it in scanner output."""
    raw = raw.partition("\t")[0]
    if raw == "/dev/null":
        return None
    try:
        decoded = ast.literal_eval(raw) if raw.startswith('"') else raw
    except (SyntaxError, ValueError):
        return None
    if not isinstance(decoded, str) or not decoded.startswith("a/"):
        return None
    return decoded[2:]


def _first_parent_ranges(repo: Path, sha: str, parent: str) -> list[tuple[str, int, int]]:
    """Return parent-side changed line ranges from a zero-context first-parent diff."""
    patch = _git(
        repo,
        "diff",
        "--unified=0",
        "--no-color",
        "--find-renames",
        "--no-ext-diff",
        parent,
        sha,
        "--",
    )
    old_path: str | None = None
    ranges: list[tuple[str, int, int]] = []
    for line in patch.splitlines():
        path_match = _DIFF_OLD_PATH.match(line)
        if path_match:
            old_path = _decode_diff_path(path_match.group(1))
            continue
        hunk_match = _DIFF_HUNK.match(line)
        if not hunk_match or old_path is None:
            continue
        start = int(hunk_match.group(1))
        count = int(hunk_match.group(2) or "1")
        if count > 0:
            ranges.append((old_path, start, count))
    return ranges


def _commit_metadata(
    repo: Path,
    sha: str,
    cache: dict[str, tuple[int, str] | None],
) -> tuple[int, str] | None:
    if sha in cache:
        return cache[sha]
    try:
        raw = _git(repo, "show", "-s", "--format=%at%x1f%s", sha).strip()
        epoch, subject = raw.split(_FS, 1)
        value = (int(epoch), _classify_commit_subject(subject)["type"])
    except (subprocess.CalledProcessError, ValueError):
        value = None
    cache[sha] = value
    return value


def _age_bucket(age_days: int) -> str:
    if age_days <= 1:
        return "0_1d"
    if age_days <= 7:
        return "2_7d"
    if age_days <= 30:
        return "8_30d"
    if age_days <= 90:
        return "31_90d"
    if age_days <= 365:
        return "91_365d"
    return "366d_plus"


def _analyze_fix_commit(repo: Path, sha: str, fix_dt: datetime) -> dict[str, Any] | None:
    """Measure parent-side lines touched by a fix using first-parent blame.

    Failures are coverage gaps, not fabricated zeroes. A root or unavailable parent omits the
    observation; individual unblamable ranges remain visible through candidate-vs-blamed counts.
    """
    try:
        parent = _git(repo, "rev-parse", f"{sha}^1").strip()
        ranges = _first_parent_ranges(repo, sha, parent)
    except subprocess.CalledProcessError:
        return None

    candidate_lines = sum(count for _path, _start, count in ranges)
    if candidate_lines > _MAX_FIX_PARENT_LINES:
        return None
    age_buckets = {bucket: 0 for bucket in _FIX_AGE_BUCKETS}
    blamed_lines = 0
    prior_fix_lines = 0
    metadata_cache: dict[str, tuple[int, str] | None] = {}

    for path, start, count in ranges:
        try:
            blame = _git(
                repo,
                "blame",
                "--line-porcelain",
                "-L",
                f"{start},{start + count - 1}",
                parent,
                "--",
                path,
            )
        except subprocess.CalledProcessError:
            continue
        for line in blame.splitlines():
            header = _BLAME_HEADER.match(line)
            if not header:
                continue
            metadata = _commit_metadata(repo, header.group(1), metadata_cache)
            if metadata is None:
                continue
            epoch, prior_type = metadata
            prior_dt = datetime.fromtimestamp(epoch, tz=timezone.utc)
            age_days = max(0, (fix_dt.astimezone(timezone.utc) - prior_dt).days)
            age_buckets[_age_bucket(age_days)] += 1
            blamed_lines += 1
            if prior_type == "fix":
                prior_fix_lines += 1

    return {
        "method": "first-parent-line-blame-v1",
        "candidate_parent_lines": candidate_lines,
        "blamed_parent_lines": blamed_lines,
        "age_buckets": age_buckets,
        "prior_fix_parent_lines": prior_fix_lines,
    }


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
            subject = body.splitlines()[0] if body else ""
            classification = _classify_commit_subject(subject)
            commit = {
                "sha": sha[:10], "author": name, "author_email": email, "ai": ai,
                "additions": adds, "deletions": dels,
                "committed_at": iso, "message": subject,
                "commit_classification": classification,
            }
            if classification["type"] == "fix":
                fix_analysis = _analyze_fix_commit(repo, sha, dt)
                if fix_analysis is not None:
                    commit["fix_analysis"] = fix_analysis
            recent.append(commit)

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
    """Read a coverage report from the working tree if present (Istanbul json or lcov).

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
    """Read a test-result report from the working tree if present (Vitest/Jest JSON, or JUnit XML).

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
    return _read_test_results_json(repo) or _read_test_results_junit(repo) or {
        "total": None,
        "passed": None,
        "skipped": None,
        "failed": None,
    }


def _int_or_none(value: Any) -> int | None:
    """An int, or None. `bool` is an int subclass — exclude it so `true` isn't read as 1."""
    return int(value) if isinstance(value, int) and not isinstance(value, bool) else None


def _read_test_results_json(repo: Path) -> dict[str, int | None] | None:
    """Vitest/Jest JSON reporter. None (not a zero-filled dict) when no such report is there."""
    import json

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
        total = _int_or_none(doc.get("numTotalTests"))
        if total is None:
            continue  # not a Vitest/Jest JSON report — keep looking
        return {
            "total": total,
            "passed": _int_or_none(doc.get("numPassedTests")),
            # Jest/Vitest split "not run" across pending (it.skip) and todo (it.todo).
            "skipped": _sum_or_none(
                _int_or_none(doc.get("numPendingTests")), _int_or_none(doc.get("numTodoTests"))
            ),
            "failed": _int_or_none(doc.get("numFailedTests")),
        }
    return None


def _junit_suite_totals(root: Any) -> dict[str, int] | None:
    """Sum the LEAF ``testsuite`` elements under a parsed JUnit root.

    Leaves only: aggregated files (Ant, some Karma/Gradle merges) nest ``testsuite`` inside
    ``testsuite`` with the parent carrying rolled-up counts, so summing every descendant counts
    each case twice — inflating the totals and able to make a clean run report as partial.
    """
    # Match on the LOCAL name. ElementTree renders a namespaced element's tag as
    # `{urn:junit}testsuite`, so an equality test against "testsuite" silently matches nothing
    # and a perfectly good `<testsuites xmlns="urn:junit">` report becomes "no report" — the
    # exact silent degradation these fields exist to surface.
    all_suites = [el for el in root.iter() if _local_name(el.tag) == "testsuite"]
    suites = [el for el in all_suites if not _has_child_suite(el)]
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
    return agg if seen else None


def _read_test_results_junit(repo: Path) -> dict[str, int | None] | None:
    """JUnit XML. None when no parseable report is there.

    Parsed with ``defusedxml``: a scanned repo's report is not necessarily a file we
    wrote (``aios-ingest scan`` runs against whatever checkout it is pointed at), and the stdlib
    ``xml.etree.ElementTree`` is vulnerable to XXE and entity-expansion attacks. A malformed
    document degrades to unknown; it must never abort a scan.
    """
    from defusedxml.ElementTree import ParseError, parse

    for rel in _TEST_REPORT_JUNIT:
        p = repo / rel
        if not p.is_file():
            continue
        try:
            agg = _junit_suite_totals(parse(p).getroot())
        except (ParseError, OSError, ValueError):
            continue
        if agg is None:
            continue
        # `errors` count as failures — a fixture or collection error is a case that did not pass,
        # and a scanner that dropped them would report a clean run for a broken one.
        failed = agg["failures"] + agg["errors"]
        # …but several runners count an error WITHOUT incrementing `tests` (pytest emits a suite
        # reporting zero tests and one error for a collection error). Taking `tests` at face value
        # there yields failed > total, which the brain rejects at the boundary — losing the ENTIRE
        # scan, contributions and issues included, over one degraded report. The total is
        # therefore at least the sum of its parts.
        total = max(agg["tests"], agg["skipped"] + failed)
        return {
            "total": total,
            "passed": max(0, total - agg["skipped"] - failed),
            "skipped": agg["skipped"],
            "failed": failed,
        }
    return None


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
    # Coverage and test-result reports are read from the WORKING TREE, not from HEAD. They are
    # build artefacts — `coverage/` is gitignored in most repos here — so requiring them to be
    # committed would mean they could essentially never be populated. The consequence, which
    # brain-api.md states normatively: two scans of the SAME commit can legitimately disagree
    # (a CI runner that just ran the suite vs. a clean clone), and since a metrics point is
    # keyed (codebase_id, head_sha), the later push replaces the earlier. That is not new in
    # 1.22 — `test_coverage_pct` has always worked this way — but 1.22 makes it visible.
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
    """Drop a numerator/denominator pair to UNKNOWN unless it is a coherent pair of counts.

    The brain rejects an incoherent pair at the boundary (422) — and that 422 kills the WHOLE
    scan, contributions and GitHub issues included, not just the offending field. It also
    returns before `recordIngestRun`, so the failure is absent from the ingest run log. One
    malformed report would therefore take a repo's entire analytics offline, silently. That is
    a worse version of the degradation this feature exists to expose.

    So the scanner never ships a group the brain will refuse. Two ways a group can be wrong,
    and the second is the one that got away the first time:

    * a numerator that doesn't fit its denominator (``covered > total``), and
    * **a NEGATIVE count.** The brain's schema is `int().nonnegative()`, and `-2 > -1` is
      false — so an ordering test alone waves negatives straight through. A count below zero
      is not a small error in a real measurement; it means the file was not the report we
      thought it was.

    Incoherent means the report was parsed wrong or written wrong, and "we don't know" is the
    honest reading of that — the one state the rest of this change is built to represent safely.
    """
    if _is_incoherent_group(total, [part]):
        return None, None
    return total, part


def _coherent_run(
    total: int | None, passed: int | None, skipped: int | None, failed: int | None
) -> tuple[int | None, int | None, int | None, int | None]:
    """Same rule for the test-run counts, plus one the pairwise form cannot express.

    Voided as a GROUP rather than per-field, because the counts are only meaningful together —
    keeping `skipped` from a report whose `total` we just disbelieved would let the dashboard
    call a run partial on evidence we rejected.

    The extra rule: the parts must FIT TOGETHER inside the total, not merely each fit
    individually. `{total: 10, passed: 10, skipped: 10, failed: 10}` passes three separate
    `part <= total` checks and still describes thirty outcomes in a ten-test run.
    """
    parts = [passed, skipped, failed]
    if _is_incoherent_group(total, parts):
        return None, None, None, None
    # Summed over the parts that are KNOWN, not only when all three are: passed/skipped/failed
    # are disjoint outcomes, so the known ones alone can never legitimately exceed the total —
    # an unknown part can only add more. Requiring all three first missed
    # `{total: 10, passed: 9, failed: 9}`, already impossible without knowing the skips.
    # Under-summing stays legal: an unallocated remainder is not a contradiction.
    known = [p for p in parts if p is not None]
    if total is not None and known and sum(known) > total:
        return None, None, None, None
    return total, passed, skipped, failed


def _local_name(tag: Any) -> str:
    """`{urn:junit}testsuite` -> `testsuite`. A plain tag passes through unchanged."""
    text = str(tag)
    return text.rsplit("}", 1)[-1] if text.startswith("{") else text


def _has_child_suite(element: Any) -> bool:
    """True when this suite wraps another — i.e. it is a rollup, not a leaf. Namespace-agnostic."""
    return any(_local_name(child.tag) == "testsuite" for child in element)


def _coherent_coverage(
    pct: float | None, total: int | None, covered: int | None
) -> tuple[int | None, int | None]:
    """Void the coverage COUNTS when they contradict the percentage reported beside them.

    The two arrive by different routes and nothing upstream forces them to agree: the lcov path
    recomputes `pct` from the same LH/LF sums it reports, so it is self-consistent by
    construction, but the Istanbul path trusts whatever `pct` the tool wrote and reads
    `covered`/`total` independently. A tool that reports 99% next to 0-of-100 covered lines is
    making two incompatible claims, and the brain refuses the pair at the boundary — which
    costs the whole scan.

    The COUNTS are what gets dropped, never the percentage: `test_coverage_pct` is the
    pre-1.22 headline that every existing row and consumer already depends on, so the safe
    degradation is back to exactly what this repo reported yesterday — a percentage of unknown
    scope, now rendered as such. Tolerance matches the brain's (1 point) so the two cannot
    disagree about what counts as a contradiction.
    """
    if pct is None or total is None or covered is None or total <= 0:
        return total, covered
    implied = (100.0 * covered) / total
    return (None, None) if abs(implied - pct) > 1 else (total, covered)


def _is_incoherent_group(total: int | None, parts: list[int | None]) -> bool:
    """True when a count group cannot be a real measurement: any negative, or a part > total."""
    for value in (total, *parts):
        if value is not None and value < 0:
            return True
    return total is not None and any(p is not None and p > total for p in parts)


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
    cov_lines, cov_covered = _coherent_coverage(c.get("lines"), cov_lines, cov_covered)
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
        # brain-api 1.24 (AIO-1011) — WHICH SCANNER BUILD produced this payload. Emitted on every
        # block, historical backfill included: a backfilled point was produced by THIS scanner
        # reading a past commit, so the build that made it is this one, not the one that existed
        # then. Both are already normalized by `aios_ingest.build` and are None when unknown —
        # never a placeholder string, and never a guess. `None` reads as "unknown scanner", which
        # is exactly what an unidentifiable build is; the brain never reads it as "current".
        "scanner_version": scanner_version(),
        "scanner_sha": scanner_sha(),
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
