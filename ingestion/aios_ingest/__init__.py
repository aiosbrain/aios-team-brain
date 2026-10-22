"""AIOS Team Brain ingestion sidecar.

Imports open-source readers (LlamaHub, Unstructured), normalizes their output into
the brain's ItemPayload contract, and POSTs to ``/api/v1/items`` — reusing the brain's
audited, dedup-by-sha256, tier-enforcing write path. No new write path; talks HTTP only.
"""

# brain-api 1.24 (AIO-1011): this string is now WIRE-VISIBLE. Every scan payload carries it as
# `metrics.scanner_version`, and the brain compares it against the contract's declared
# `minScannerVersion` to decide whether a repo's pinned scanner predates what the contract needs.
# Bump it whenever this package gains output a contract revision asks for — otherwise a scanner
# that cannot produce a new field is indistinguishable from one that had nothing to report.
# Keep in lockstep with pyproject.toml's `version` (tests/test_scanner_identity.py asserts it).
__version__ = "0.2.0"
