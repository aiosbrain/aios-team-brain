"""AIOS Team Brain ingestion sidecar.

Imports open-source readers (LlamaHub, Unstructured), normalizes their output into
the brain's ItemPayload contract, and POSTs to ``/api/v1/items`` — reusing the brain's
audited, dedup-by-sha256, tier-enforcing write path. No new write path; talks HTTP only.
"""

__version__ = "0.1.0"
