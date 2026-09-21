#!/usr/bin/env bash
# Build the Graphiti image FRESH and prove the keyless staging mode against it — AIO-997 / AC-07.
#
# Run from the repository root:
#
#     bash graphiti/keyless-image-check.sh [tag]
#
# It is one command on purpose. The three things it does are the three that cannot be established
# from source: the image builds (its build-time gates all pass), the shipped CMD is the mode-selecting
# target invoked through the venv binary, and a real container serves and refuses the way AC-07 says.
#
# ⚠️ This tests an image you just built. It says NOTHING about what the staging service is running:
# a Railway custom start command OVERRIDES the image CMD, and the measured live override invokes
# /app/.venv/bin/uvicorn directly against the OLD target — so it bypasses the selector entirely and
# starts key-requiring code. Clearing that override is a commissioning step (docs/OPS.md §11); this
# script cannot do it and does not check it.
#
# The diagnostic and its tripwire are MOUNTED read-only for the run. Neither is in the image; the
# unit guard asserts the Dockerfile does not copy them.
set -euo pipefail

TAG="${1:-aios-graphiti:keyless-check}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_CMD='["/app/.venv/bin/uvicorn","graph_service.staging_entry:app","--host","0.0.0.0","--port","8000"]'

echo "== building ${TAG} from ${ROOT}/graphiti"
docker build -t "${TAG}" "${ROOT}/graphiti"

echo "== image identity (record this in the commissioning packet)"
docker image inspect --format 'id={{.Id}}' "${TAG}"
docker image inspect --format 'repo_digests={{json .RepoDigests}}' "${TAG}"

echo "== shipped CMD"
ACTUAL_CMD="$(docker image inspect --format '{{json .Config.Cmd}}' "${TAG}")"
echo "${ACTUAL_CMD}"
if [ "${ACTUAL_CMD}" != "${EXPECTED_CMD}" ]; then
  echo "FAIL image CMD is not the mode-selecting entry:" >&2
  echo "  expected ${EXPECTED_CMD}" >&2
  echo "  actual   ${ACTUAL_CMD}" >&2
  exit 1
fi

echo "== keyless diagnostic (network disabled, sources mounted read-only)"
docker run --rm --network none \
  -v "${ROOT}/graphiti:/diag:ro" \
  "${TAG}" \
  /app/.venv/bin/python /diag/staging-keyless-diagnostic.py
