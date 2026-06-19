"""Vendored AEM rubric data (package resource).

`agent-readiness.json` is a committed copy of the canonical rubric that lives in the
sibling repo `agentic-engineering-maturity/rubric/agent-readiness.json`. It is vendored
here so the deployed ingestion sidecar is self-contained (no runtime fetch or mounted
file). Every scan records `readiness_rubric_version` so a stale copy is observable.

Refresh from canonical with `scripts/refresh-rubric.sh`. Loaded via importlib.resources
(see analyzers/readiness.py) so it works from the installed wheel, not just the source tree.
"""
