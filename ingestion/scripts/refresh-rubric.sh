#!/usr/bin/env bash
# Refresh the vendored AEM agent-readiness rubric from the canonical sibling repo.
#
# The canonical rubric lives in agentic-engineering-maturity/ (a sibling of aios-team-brain
# in the AIOS context monorepo). The ingestion package vendors a copy so the deployed
# sidecar is self-contained. Run this when the canonical rubric changes.
#
# Usage: ingestion/scripts/refresh-rubric.sh [path-to-canonical-json]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"        # ingestion/scripts
dest="$here/../aios_ingest/rubric/agent-readiness.json"
src="${1:-$here/../../../agentic-engineering-maturity/rubric/agent-readiness.json}"

if [[ ! -f "$src" ]]; then
  echo "canonical rubric not found at: $src" >&2
  echo "pass the path explicitly: refresh-rubric.sh /path/to/agent-readiness.json" >&2
  exit 1
fi

cp "$src" "$dest"
ver="$(python3 -c "import json,sys; print(json.load(open('$dest'))['version'])")"
echo "refreshed vendored rubric → $dest (version $ver)"
echo "commit the change; readiness_rubric_version will report $ver on new scans."
