"""Which scanner build produced a payload — brain-api 1.24 (AIO-1011).

**The failure this exists for.** brain-api 1.22 shipped the coverage denominator and it never
arrived. All seven consuming repos fetch this scanner pinned to an exact commit in their own
``.github/scripts/fetch-brain-scanner.sh``, and all seven were pinned to a build from three weeks
earlier that had never heard of the new fields. Every scan returned 200. Nothing went red. The
brain rendered ``(scope unknown)`` for the entire fleet, permanently, and it was caught by a human
looking at a screenshot.

The pin is not the defect — it is a deliberate supply-chain control, since this code executes in
another repo's CI holding that repo's brain credentials. The defect is that a payload could not
say what built it, so a scan from an old scanner and a scan from today's scanner with genuinely
nothing to report were indistinguishable.

Two facts, with different jobs:

* ``scanner_version`` — the package version (``aios_ingest.__version__``). ORDERED, so the brain
  can compare it against the contract's declared ``minScannerVersion``. This is the one that
  decides staleness.
* ``scanner_sha`` — the git commit this checkout sits at, when that is knowable. PROVENANCE ONLY.
  It is what you need in order to find and bump a stale pin, and it is deliberately NOT the
  staleness measure: commit identity has no order, means nothing across branches or forks, and
  stops existing the moment this package ships from an index.

**Neither may ever cost a scan.** A malformed value is voided to ``None`` here, at the scanner's
own choke point, rather than sent for the brain to reject — a 422 drops the repo's ENTIRE scan
(metrics, findings, contributions, issues) and returns before the ingest run is recorded, so the
failure is not even logged. Provenance is never worth that. ``None`` is the honest reading of a
build we cannot identify, and the brain renders it as "unknown scanner", never as "current".
"""

from __future__ import annotations

import re
import subprocess
from functools import lru_cache
from pathlib import Path

from . import __version__

# A dotted release version the brain can ORDER. Deliberately permissive about what follows the
# three numbers (a local build may carry `+dirty`, an rc may carry `-rc1`); deliberately strict
# that the three numbers are there, because an unorderable string cannot answer the only question
# the field exists to answer. The charset MIRRORS the brain's `parseScannerVersion`
# (lib/codebases/scanner-version.ts) — if the two disagreed, this scanner would send a value it
# considers valid that the brain reads as "unknown", flagging itself stale for no reason.
_VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.\-+]*)?$")
_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")
# Both fields become bounded TEXT columns on `code_metrics`; the wire contract caps them at 64.
# Truncating would invent a version that was never built, so an over-long value is voided.
_MAX_LEN = 64


def normalize_scanner_version(raw: str | None) -> str | None:
    """A parseable, bounded release version — or ``None`` for "we don't know"."""
    if not raw:
        return None
    value = raw.strip()
    if len(value) > _MAX_LEN or not _VERSION_RE.match(value):
        return None
    return value


def normalize_scanner_sha(raw: str | None) -> str | None:
    """A lowercase hex commit id — or ``None``. Never a branch name, never "unknown"."""
    if not raw:
        return None
    value = raw.strip().lower()
    if len(value) > _MAX_LEN or not _SHA_RE.match(value):
        return None
    return value


def scanner_version() -> str | None:
    """The build that is running. ``None`` only if the package version is itself unreadable."""
    return normalize_scanner_version(__version__)


@lru_cache(maxsize=1)
def scanner_sha() -> str | None:
    """The commit this checkout sits at, or ``None``.

    Resolved against the directory holding this module, NOT the working directory: the scanner
    runs inside the repository it is scanning, and ``git rev-parse`` from the cwd would report the
    SCANNED repo's HEAD — which is already in the payload as ``head_sha`` and would make the two
    fields silently agree on every self-scan, so the provenance would be worthless exactly where
    it is needed.

    ``fetch-brain-scanner.sh`` leaves a real detached checkout at the pinned commit, so in CI this
    is exactly the pinned SHA. An install with no git history (a future package install) yields
    ``None``, which is the truth and is a state the brain renders explicitly.
    """
    here = Path(__file__).resolve().parent
    try:
        out = subprocess.run(
            ["git", "-C", str(here), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        # No git binary, no permission, hung process — all mean "cannot identify the build".
        # None of them mean the scan should fail.
        return None
    if out.returncode != 0:
        return None
    return normalize_scanner_sha(out.stdout)
