"""brain-api 1.24 (AIO-1011) — the payload declares which scanner build produced it.

The bug being closed: a scan from a scanner pinned three weeks back and a scan from today's
scanner that genuinely had nothing to report looked identical on the wire. These tests pin the
properties that make them distinguishable, and keep the field from ever costing a scan.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

from aios_ingest import __version__
from aios_ingest.analyzers.codebase import _metrics_block
from aios_ingest.build import (
    normalize_scanner_sha,
    normalize_scanner_version,
    scanner_sha,
    scanner_version,
)

_GIT = {
    "commits_window": 0,
    "ai_commits_window": 0,
    "additions_window": 0,
    "deletions_window": 0,
    "recent_commits": [],
    "active_days": 0,
    "days_since_last_commit": None,
    "contributions": [],
}
_SCAFF = {
    "loc": 0,
    "files": 0,
    "has_claude_md": False,
    "has_agents_md": False,
    "agents_md_count": 0,
    "skills_count": 0,
    "commands_count": 0,
}


def _block(**kw):
    return _metrics_block(_GIT, _SCAFF, None, "a" * 40, 90, **kw)


def test_package_version_matches_pyproject():
    """One version, two files. The wire now reads it, so a drift is a wrong claim on the wire."""
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    declared = tomllib.loads(pyproject.read_text())["project"]["version"]
    assert declared == __version__


def test_version_is_at_least_the_contract_minimum():
    """The build must be able to satisfy what the current contract asks for.

    `minScannerVersion` in aios-workspace/docs/contract/brain-contract.json is 0.2.0 at
    brain-api 1.24. A scanner shipping BELOW its own contract's minimum would flag itself as
    stale on every scan it ever pushed.
    """
    assert tuple(int(p) for p in __version__.split(".")[:3]) >= (0, 2, 0)


def test_every_payload_declares_the_build_that_made_it():
    block = _block()
    assert block["scanner_version"] == __version__
    # Running from a checkout, so the SHA is knowable and is THIS repo's HEAD — not the scanned
    # repo's head_sha, which the block already carries separately.
    assert block["scanner_sha"] != block["head_sha"]


def test_historical_backfill_declares_the_same_build():
    """A backfilled point was produced by THIS scanner reading a past commit.

    The build that made the payload is the one running now, not whatever existed at that commit.
    Claiming otherwise would forge provenance for a point nobody old ever pushed.
    """
    assert _block(scanned_at="2026-01-01T00:00:00Z")["scanner_version"] == __version__


def test_unparseable_versions_void_to_unknown_rather_than_shipping():
    """Voided HERE, at the scanner's choke point — never sent for the brain to reject.

    A 422 drops the repo's ENTIRE scan (metrics, findings, contributions, issues) and returns
    before the ingest run is recorded, so the failure is not even logged. A version string can
    never be worth a repository's whole analytics.
    """
    for bad in ["", "   ", "nightly", "v0.2.0", "0.2", "main", "0.2.0 rc1", "0.2.0" + "x" * 64, None]:
        assert normalize_scanner_version(bad) is None, bad


def test_real_release_shapes_survive_normalization():
    for good in ["0.2.0", "1.0.0", "10.20.30", "0.10.0"]:
        assert normalize_scanner_version(good) == good, good


def test_suffixed_builds_are_unreadable_and_void_rather_than_being_stripped():
    """A suffix is never stripped and shipped as if it were the release.

    These were ACCEPTED in the first draft, and the brain then compared their numeric core: it
    read `0.2.0-alpha.1` as "current" though a SemVer prerelease sorts before its release, and
    `0.1.0-rc.1` as "stale" — an ordering verdict about a string nobody had fully read. Voiding
    to None here is the same conclusion one hop earlier, and it keeps this grammar identical to
    the brain's `parseScannerVersion`, which is what stops a valid-here/unknown-there mismatch
    flagging a current build.

    Accepted cost, stated: a genuine release candidate reports an unknown build rather than a
    current one. "I could not read this" is true; "this is current" would be a guess.
    """
    for suffixed in [
        "0.2.0-alpha.1",
        "0.2.0-rc1",
        "0.2.0+dirty",
        "0.2.0+build.5",
        "0.2.0-",
        "1.0.0.0",
    ]:
        assert normalize_scanner_version(suffixed) is None, suffixed


def test_sha_normalization_refuses_anything_that_is_not_a_commit():
    # "unknown", a branch name and a tag are all things a naive implementation would happily
    # store — and all of them would make the provenance field lie about being a commit.
    for bad in ["", "unknown", "HEAD", "main", "xyz", "a" * 6, "a" * 65, None]:
        assert normalize_scanner_sha(bad) is None, bad
    assert normalize_scanner_sha("  DD42BE421D436BF1A8993AB62F79D35E4AD63B0 \n") == (
        "dd42be421d436bf1a8993ab62f79d35e4ad63b0"
    )


def test_identity_is_resolvable_in_this_checkout():
    assert scanner_version() == __version__
    sha = scanner_sha()
    assert sha is not None and len(sha) == 40


def test_sha_is_read_from_the_module_not_the_working_directory(tmp_path, monkeypatch):
    """The scanner runs INSIDE the repo it is scanning.

    Resolving the SHA from the cwd would report the scanned repo's HEAD, so the two fields would
    silently agree on every self-scan and the provenance would be worthless exactly where it is
    needed. Pinned by changing the cwd to somewhere with no git repo at all: the answer must not
    move.
    """
    before = scanner_sha.__wrapped__()
    monkeypatch.chdir(tmp_path)
    assert scanner_sha.__wrapped__() == before


def test_a_scanner_that_cannot_identify_itself_still_scans(monkeypatch):
    """No git binary is a reason to say "unknown", never a reason to fail a scan."""
    import aios_ingest.build as build

    def boom(*_a, **_kw):
        raise OSError("git: command not found")

    monkeypatch.setattr(build.subprocess, "run", boom)
    assert build.scanner_sha.__wrapped__() is None
