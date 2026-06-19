"""Agent-readiness scorer — the ONE scanner-side exception to "the brain computes scores".

Grades a repo against the vendored AEM rubric (``rubric/agent-readiness.json``). The rubric's
checks are filesystem questions — does ``.github/workflows`` exist? is CLAUDE.md >= 400 bytes? —
that only the scanner can answer (the brain has no repo access). So readiness is scored HERE and
the brain persists it verbatim (see ``docs/ARCHITECTURE.md`` and ``aios-workspace/docs/brain-api.md``).
Every other score (``agentic_score``, ``health_score``) stays brain-side in ``lib/codebases/score.ts``.

``score_readiness()`` returns a fully-scored dict on success or ``None`` on ANY failure: it never
raises and never builds the schema-safe null shape — normalizing ``None`` into the four-key payload
is ``_metrics_block``'s single responsibility.

Scoring is deterministic and tracked-file scoped (``git ls-files``). All matchers refuse to read
outside the repo, so even a hand-supplied ``--readiness-rubric`` can't probe the host filesystem.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from importlib import resources
from pathlib import Path, PurePosixPath
from typing import Any

try:  # py311+ ships tomllib; guard so the scorer degrades instead of crashing the import
    import tomllib
except ModuleNotFoundError:  # pragma: no cover
    tomllib = None  # type: ignore[assignment]

log = logging.getLogger(__name__)

_GLOB_CHARS = re.compile(r"[*?\[\]{}]")
_REQUIRED_KEYS = (
    "version", "levels", "pillars", "checks",
    "advanceThreshold", "verificationCapLevel", "verificationCapPillar",
)


# ── rubric loading ────────────────────────────────────────────────────────────────────────

def _load_rubric(rubric_path: str | None) -> dict[str, Any] | None:
    """Load the rubric from an explicit path, else the vendored package copy. None on failure."""
    try:
        if rubric_path:
            text = Path(rubric_path).read_text(encoding="utf-8")
        else:
            res = resources.files("aios_ingest.rubric") / "agent-readiness.json"
            text = res.read_text(encoding="utf-8")
        data = json.loads(text)
    except (OSError, ValueError) as exc:
        log.warning("readiness: could not load rubric (%s)", exc)
        return None
    if not isinstance(data, dict) or not all(k in data for k in _REQUIRED_KEYS):
        log.warning("readiness: rubric missing required keys")
        return None
    return data


# ── path safety + glob engine ─────────────────────────────────────────────────────────────

def _safe_rel(entry: str) -> str | None:
    """A repo-relative path safe to open, or None. Rejects absolute / ~ / `..` traversal."""
    if not entry or entry.startswith("/") or entry.startswith("~"):
        return None
    if ".." in PurePosixPath(entry).parts:
        return None
    return entry


def _expand_braces(pattern: str) -> list[str]:
    """Expand `{a,b,c}` alternations (recursively, for multiple groups)."""
    m = re.search(r"\{([^{}]*)\}", pattern)
    if not m:
        return [pattern]
    pre, post = pattern[: m.start()], pattern[m.end():]
    out: list[str] = []
    for opt in m.group(1).split(","):
        out.extend(_expand_braces(pre + opt + post))
    return out


def _glob_regex(pattern: str) -> re.Pattern[str]:
    """Translate one brace-free glob to an anchored regex with `**` semantics.

    `**/`→ zero-or-more path segments, `**`→ anything, `*`→ within a segment, `?`→ one char.
    (`fnmatch` can't express `**` or segment-bounded `*`, hence the hand translation.)
    """
    i, n = 0, len(pattern)
    out = ["^"]
    while i < n:
        c = pattern[i]
        if c == "*":
            if pattern[i : i + 2] == "**":
                i += 2
                if pattern[i : i + 1] == "/":
                    out.append("(?:.*/)?")  # **/ — optional leading segments
                    i += 1
                else:
                    out.append(".*")  # ** — across segments
            else:
                out.append("[^/]*")  # * — within one segment
                i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    out.append("$")
    return re.compile("".join(out))


def _glob_match(paths: list[str], pattern: str) -> bool:
    regexes = [_glob_regex(p) for p in _expand_braces(pattern)]
    return any(rx.match(path) for rx in regexes for path in paths)


def _path_exists(entry: str, tracked_set: set[str], tracked_list: list[str]) -> bool:
    """Tracked-file existence for an anyFileExists entry — literal file, directory prefix,
    or (when the entry carries glob chars, e.g. `**/logger.*`) a glob match."""
    if _GLOB_CHARS.search(entry):
        return _glob_match(tracked_list, entry)
    e = entry.rstrip("/")
    if e in tracked_set:
        return True
    prefix = e + "/"
    return any(p.startswith(prefix) for p in tracked_list)


# ── file/content/config/dependency matchers (all tracked-file scoped) ───────────────────────

def _resolve_in_repo(repo: Path, rel: str | None, tracked_set: set[str]) -> Path | None:
    """A real, openable path for `rel`, or None. Beyond the relpath-text + tracked-set checks,
    fully resolve symlinks and require the target stay under repo.resolve() — a tracked file
    can itself be a symlink (or sit behind a symlinked dir) pointing outside the repo, and
    read_text()/stat() would otherwise follow it off the host filesystem."""
    safe = _safe_rel(rel) if rel else None
    if safe is None or safe not in tracked_set:
        return None
    repo_root = repo.resolve()
    target = (repo_root / safe).resolve()
    if target != repo_root and not target.is_relative_to(repo_root):
        return None
    return target


def _read_text(repo: Path, rel: str | None, tracked_set: set[str]) -> str | None:
    target = _resolve_in_repo(repo, rel, tracked_set)
    if target is None:
        return None
    try:
        return target.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None


def _file_min_bytes(spec: dict[str, Any], repo: Path, tracked_set: set[str]) -> bool:
    need = spec.get("bytes", 0)
    for rel in spec.get("anyOf", []):
        target = _resolve_in_repo(repo, rel, tracked_set)
        if target is None:
            continue
        try:
            if target.stat().st_size >= need:
                return True
        except OSError:
            continue
    return False


def _toml_has_section(data: dict[str, Any], dotted: str) -> bool:
    cur: Any = data
    for part in dotted.split("."):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return False
    return True


def _config_key(specs: list[dict[str, Any]], repo: Path, tracked_set: set[str]) -> bool:
    for spec in specs:
        fname = spec.get("file", "")
        text = _read_text(repo, fname, tracked_set)
        if text is None:
            continue
        if fname.endswith(".json"):
            try:
                data = json.loads(text)
            except ValueError:
                continue
            key = spec.get("key")
            if key and isinstance(data, dict) and key in data:
                return True
        elif fname.endswith(".toml") and tomllib is not None:
            try:
                data = tomllib.loads(text)
            except (ValueError, tomllib.TOMLDecodeError):
                continue
            section = spec.get("section")
            if section and _toml_has_section(data, section):
                return True
    return False


def _pep508_name(spec: str) -> str:
    m = re.match(r"\s*([A-Za-z0-9._-]+)", spec or "")
    return m.group(1).lower() if m else ""


def _dependency(names: list[str], repo: Path, tracked_set: set[str]) -> bool:
    """Match a dependency name across the manifest sections in the documented contract:
    package.json {dependencies, devDependencies}; pyproject [project].dependencies + ALL
    [project.optional-dependencies] groups; Cargo {dependencies, dev-dependencies,
    build-dependencies}. Case-insensitive exact name match (no fuzzy prefixing)."""
    wanted = {n.strip().lower() for n in names if n.strip()}
    collected: set[str] = set()

    pj = _read_text(repo, "package.json", tracked_set)
    if pj:
        try:
            data = json.loads(pj)
            for sect in ("dependencies", "devDependencies"):
                deps = data.get(sect)
                if isinstance(deps, dict):
                    collected.update(k.lower() for k in deps)
        except ValueError:
            pass

    if tomllib is not None:
        pp = _read_text(repo, "pyproject.toml", tracked_set)
        if pp:
            try:
                data = tomllib.loads(pp)
                proj = data.get("project", {}) if isinstance(data, dict) else {}
                for spec in proj.get("dependencies", []) or []:
                    collected.add(_pep508_name(spec))
                for group in (proj.get("optional-dependencies", {}) or {}).values():
                    for spec in group or []:
                        collected.add(_pep508_name(spec))
            except (ValueError, tomllib.TOMLDecodeError):
                pass

        cg = _read_text(repo, "Cargo.toml", tracked_set)
        if cg:
            try:
                data = tomllib.loads(cg)
                for sect in ("dependencies", "dev-dependencies", "build-dependencies"):
                    deps = data.get(sect) if isinstance(data, dict) else None
                    if isinstance(deps, dict):
                        collected.update(k.lower() for k in deps)
            except (ValueError, tomllib.TOMLDecodeError):
                pass

    collected.discard("")
    return bool(wanted & collected)


def _file_contains(specs: list[dict[str, Any]], repo: Path, tracked_set: set[str]) -> bool:
    for spec in specs:
        text = _read_text(repo, spec.get("file"), tracked_set)
        if text is None:
            continue
        if any(sub in text for sub in spec.get("anyOf", [])):
            return True
    return False


def _eval_signal(
    signal: dict[str, Any], repo: Path, tracked_set: set[str], tracked_list: list[str]
) -> bool:
    """A check passes if its primary matcher OR any `or*` fallback matcher passes."""
    if "anyFileExists" in signal and any(
        _path_exists(e, tracked_set, tracked_list) for e in signal["anyFileExists"]
    ):
        return True
    if "anyPathMatches" in signal and any(
        _glob_match(tracked_list, p) for p in signal["anyPathMatches"]
    ):
        return True
    if "fileMinBytes" in signal and _file_min_bytes(signal["fileMinBytes"], repo, tracked_set):
        return True
    if "orConfigKey" in signal and _config_key(signal["orConfigKey"], repo, tracked_set):
        return True
    if "orDependency" in signal and _dependency(signal["orDependency"], repo, tracked_set):
        return True
    if "orFileContains" in signal and _file_contains(signal["orFileContains"], repo, tracked_set):
        return True
    return False


# ── scoring ────────────────────────────────────────────────────────────────────────────────

def _git_ls_files(repo: Path) -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"], cwd=repo, capture_output=True, text=True, check=True
    )
    return [line for line in out.stdout.splitlines() if line]


def _score(repo: Path, rubric: dict[str, Any]) -> dict[str, Any]:
    tracked_list = _git_ls_files(repo)
    tracked_set = set(tracked_list)
    checks = rubric["checks"]
    levels = rubric["levels"]
    level_order = {lvl["id"]: i for i, lvl in enumerate(levels)}

    results = {
        c["id"]: _eval_signal(c["signal"], repo, tracked_set, tracked_list) for c in checks
    }

    # Per-pillar passed/total (every check belongs to exactly one pillar).
    pillars: dict[str, dict[str, int]] = {}
    for p in rubric["pillars"]:
        key = p["key"]
        pcs = [c for c in checks if c["pillar"] == key]
        pillars[key] = {"passed": sum(1 for c in pcs if results[c["id"]]), "total": len(pcs)}

    # Highest level whose CUMULATIVE checks (levels <= L) clear advanceThreshold.
    threshold = rubric["advanceThreshold"]
    claimed_idx = -1
    for ti in range(len(levels)):
        cum = [c for c in checks if level_order.get(c["level"], len(levels)) <= ti]
        if cum and sum(1 for c in cum if results[c["id"]]) / len(cum) >= threshold:
            claimed_idx = ti

    # Verification cap: no agentic maturity without verification — clamp to Lcap when the
    # testing pillar has zero passing checks.
    cap_id = f"L{rubric['verificationCapLevel']}"
    cap_idx = level_order.get(cap_id, len(levels) - 1)
    cap_pillar = rubric["verificationCapPillar"]
    if claimed_idx > cap_idx and pillars.get(cap_pillar, {}).get("passed", 0) == 0:
        claimed_idx = cap_idx

    level = levels[claimed_idx]["id"] if claimed_idx >= 0 else "L0"
    total = len(checks)
    passed_total = sum(1 for c in checks if results[c["id"]])
    pct = round(100 * passed_total / total, 2) if total else 0.0

    return {
        "readiness_level": level,
        "readiness_pct": pct,
        "readiness_pillars": pillars,
        "readiness_rubric_version": rubric.get("version"),
    }


def score_readiness(repo: Path, rubric_path: str | None = None) -> dict[str, Any] | None:
    """Score a repo's agent-readiness. Returns the 4-key readiness dict, or None on any
    failure (bad rubric, non-git repo, unexpected error) — callers normalize None to the
    schema-safe null shape. Never raises; a readiness problem must not break a scan."""
    rubric = _load_rubric(rubric_path)
    if rubric is None:
        return None
    try:
        return _score(repo, rubric)
    except Exception as exc:  # noqa: BLE001 — readiness is best-effort; the scan must survive
        log.warning("readiness: scoring failed (%s)", exc)
        return None
