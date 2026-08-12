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
cd "$(git rev-parse --show-toplevel)"

# Stable identity from the worktree path: same worktree → same container name every run.
WT_HASH=$(pwd | shasum | cut -c1-8)
NAME="aios-dm-${WT_HASH}"

if [[ "${1:-}" == "--down" ]]; then
  docker rm -f "$NAME" >/dev/null 2>&1 && echo "[dm-isolated] removed $NAME" || echo "[dm-isolated] no container $NAME"
  exit 0
fi

if [[ "${AIOS_DM_RESET:-}" == "1" ]]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
fi

if ! docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
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
  until docker exec "$NAME" pg_isready -U app >/dev/null 2>&1; do sleep 1; done
  PORT=$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')
  DATABASE_URL="postgres://app:app@localhost:${PORT}/app_test" npm run pg:schema
else
  docker start "$NAME" >/dev/null 2>&1 || true
fi

# Always read the ACTUAL mapped port (assigned at create) — never re-derive it.
PORT=$(docker port "$NAME" 5432/tcp | head -1 | sed 's/.*://')
URL="postgres://app:app@localhost:${PORT}/app_test"
echo "[dm-isolated] $NAME → $URL"
DATABASE_TEST_URL="$URL" npx vitest run --config vitest.datamechanics.config.ts "$@"
