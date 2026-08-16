#!/usr/bin/env bash
#
# Run the data-mechanics tier against a PER-WORKTREE dedicated Postgres, so parallel Conductor
# worktrees never collide on the one shared compose container (`compose.test.yml`, port 5434).
#
# WHY: `npm run test:datamechanics:local` points every worktree at localhost:5434. When two
# worktrees run the dm tier at once (common with parallel Conductor sessions) they contend on the
# same rows/locks and Postgres aborts transactions — surfacing as `deadlock detected` and
# `null.id` seed failures that read like product bugs but are pure collision (see the
# `shared-test-postgres-collision` note). This script gives each worktree its OWN container (named
# per worktree path) on a DOCKER-ASSIGNED port, so runs are hermetic and reusable.
#
# USAGE:
#   bash scripts/dm-isolated.sh                       # run the whole dm tier, isolated
#   bash scripts/dm-isolated.sh test/datamechanics/access-enforce-arcs.datamechanics.test.ts  # one file
#   bash scripts/dm-isolated.sh --down                # stop+remove THIS worktree's container
#   AIOS_DM_RESET=1 bash scripts/dm-isolated.sh       # recreate the container fresh (reload schema)
#
# The container is left UP between runs (fast reuse). It's a throwaway — safe to `--down` anytime.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)" || { echo "[dm-isolated] not in a git repo"; exit 1; }
cd "$ROOT"

# Stable identity from the worktree path: same worktree → same container name every run.
WT_HASH=$(pwd | shasum | cut -c1-8)
NAME="aios-dm-${WT_HASH}"

# Exact-name existence check — no pipe to grep (avoids a SIGPIPE-under-pipefail flip).
exists() { [[ -n "$(docker ps -a --filter "name=^${NAME}$" --format '{{.Names}}')" ]]; }

# `-v` so the postgres image's anonymous data volume goes with the container (no orphans).
if [[ "${1:-}" == "--down" ]]; then
  docker rm -f -v "$NAME" >/dev/null 2>&1 && echo "[dm-isolated] removed $NAME" || echo "[dm-isolated] no container $NAME"
  exit 0
fi

if [[ "${AIOS_DM_RESET:-}" == "1" ]]; then
  docker rm -f -v "$NAME" >/dev/null 2>&1 || true
fi

fresh=""
if ! exists; then
  # Create with a DOCKER-ASSIGNED port (`-p 0:5432`) — never a hardcoded or derived one: two
  # worktrees picking the "same free port" is exactly the collision one layer down (the
  # `shared-test-postgres-collision` note). `fsync=off` etc. is safe for a throwaway test DB and
  # keeps the TRUNCATE-per-test churn fast; disk-backed (NOT --tmpfs, which the dm tier's ~40-table
  # truncate × N files can blow through mid-run).
  echo "[dm-isolated] creating $NAME (docker-assigned port)"
  docker run -d --name "$NAME" \
    -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app_test \
    -p 0:5432 postgres:16 \
    -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c max_wal_size=1GB >/dev/null
  fresh=1
else
  docker start "$NAME" >/dev/null 2>&1 || true
fi

# Wait for readiness on BOTH paths (a just-started stopped container is still booting), bounded so a
# container that dies at startup fails loudly instead of hanging.
ready=""
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U app >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ -z "$ready" ]]; then
  echo "[dm-isolated] $NAME did not become ready in 60s"; docker logs --tail 20 "$NAME" || true; exit 1
fi

# Read the ACTUAL mapped port (assigned at create), every run — never re-derive or cache it. An
# EMPTY port would make libpq fall back to 5432 and truncate whatever Postgres is there, so guard it.
PORT=$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')
if [[ -z "$PORT" ]]; then
  echo "[dm-isolated] no port mapping for $NAME (is it running?)"; exit 1
fi
URL="postgres://app:app@localhost:${PORT}/app_test"

if [[ -n "$fresh" ]]; then
  DATABASE_URL="$URL" npm run pg:schema
fi

echo "[dm-isolated] $NAME → $URL"
DATABASE_TEST_URL="$URL" npx vitest run --config vitest.datamechanics.config.ts "$@"
