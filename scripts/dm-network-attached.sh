#!/usr/bin/env bash
#
# Run the data-mechanics specs that need a DIRECT Postgres destination, from INSIDE the database's
# own container network.
#
# WHY THIS EXISTS (M5). `assertLivePostgresTarget` refuses unless the lock-owning session's socket
# peer equals the server's own `inet_server_addr()`. That is the canonical proof the staging importer
# must satisfy before it drains a database, and it is deliberately strict: a host-published port is
# Docker NAT, so the peer the server sees is the gateway, not the client. Every ordinary local dm
# path — `npm run db:test:up` (5434), `test:datamechanics:local`, `test:datamechanics:iso` — reaches
# Postgres through exactly such a published port, so the affected specs fail locally for a reason
# that has nothing to do with the code under test.
#
# The fix is NOT to relax the check for local runs: that would delete the proof the spec exists to
# make, everywhere. It is to reach the service the way production does — by service DNS on a shared
# container network — which is also exactly what CI's `datamechanics-tests` job container does
# (`.github/workflows/ci.yml`, `DATABASE_TEST_URL=postgres://app:app@postgres:5432/app_test`).
#
# ORDINARY LOCAL DM IS UNAFFECTED. This script is a separate, opt-in lane for the affected files
# only; nothing here changes `test:datamechanics{,:local,:iso}`.
#
# The runner image is `docker/staging-ops.Dockerfile`, reused rather than reinvented: it is already
# Linux node 20 with a Linux `npm ci` and the Postgres client binaries the staging specs spawn.
#
# USAGE:
#   bash scripts/dm-network-attached.sh                       # the affected specs (default set below)
#   bash scripts/dm-network-attached.sh test/datamechanics/x.datamechanics.test.ts
#   bash scripts/dm-network-attached.sh --down                # remove THIS worktree's network + DB
#   AIOS_DM_NET_RESET=1 bash scripts/dm-network-attached.sh   # recreate the DB fresh (reload schema)
#
# ⚠️ THIS IS NOT THE RAILWAY PROOF. Passing here shows the peer check holds over a container network
# with an IPv4 bridge. Railway private networking is IPv6-only, and the driver reports peers as
# `::ffff:`-mapped or as native IPv6; `normalizedAddress` folds the mapped form, but the actual
# address family a live Railway backend reports is UNMEASURED. `assertPinnedPostgresTarget` and this
# peer check therefore remain ACTIVATION PREREQUISITES: before enabling the schedule, run
# `importer verify` against the live staging service and confirm the destination check passes on
# Railway's own network. See docs/OPS.md.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)" || { echo "[dm-network] not in a git repo" >&2; exit 1; }
cd "$ROOT"

# Same stable per-worktree identity as scripts/dm-isolated.sh, so two worktrees never share a
# network, a database or an image tag.
WT_HASH=$(pwd | shasum | cut -c1-8)
NET="aios-dm-net-${WT_HASH}"
PG="aios-dm-pg-${WT_HASH}"
IMAGE="aios-dm-runner:${WT_HASH}"

# The service DNS name the specs connect to. It is an ALIAS on the network, not a published port —
# that is the whole point.
PG_ALIAS="postgres"
URL="postgres://app:app@${PG_ALIAS}:5432/app_test"

# The specs that actually assert against the real destination. Kept explicit so this lane stays
# narrow: it is not a second way to run the dm tier.
DEFAULT_SPECS=(test/datamechanics/staging-coordinator-lock-lifetime.datamechanics.test.ts)

exists() { [[ -n "$(docker ps -a --filter "name=^${PG}$" --format '{{.Names}}')" ]]; }

if [[ "${1:-}" == "--down" ]]; then
  docker rm -f -v "$PG" >/dev/null 2>&1 && echo "[dm-network] removed $PG" || echo "[dm-network] no container $PG"
  docker network rm "$NET" >/dev/null 2>&1 && echo "[dm-network] removed $NET" || echo "[dm-network] no network $NET"
  exit 0
fi

for binary in docker git; do
  command -v "$binary" >/dev/null 2>&1 || { echo "[dm-network] requires $binary" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "[dm-network] requires a running Docker engine" >&2; exit 1; }

docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null

if [[ "${AIOS_DM_NET_RESET:-}" == "1" ]]; then docker rm -f -v "$PG" >/dev/null 2>&1 || true; fi

fresh=""
if ! exists; then
  echo "[dm-network] creating $PG on $NET (no published port — service DNS only)"
  docker run -d --name "$PG" --network "$NET" --network-alias "$PG_ALIAS" \
    -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app_test \
    postgres:16 \
    -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c max_wal_size=1GB >/dev/null
  fresh=1
else
  docker start "$PG" >/dev/null 2>&1 || true
  docker network connect "$NET" "$PG" --alias "$PG_ALIAS" >/dev/null 2>&1 || true
fi

ready=""
for _ in $(seq 1 60); do
  if docker exec "$PG" pg_isready -U app >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ -z "$ready" ]]; then
  echo "[dm-network] $PG did not become ready in 60s" >&2; docker logs --tail 20 "$PG" >&2 || true; exit 1
fi

# Rebuilt every run. `npm ci` sits in a layer keyed on package.json/package-lock.json, so an ordinary
# source edit only re-runs the COPY — and the tests must be the tree you are working in, not the tree
# the image was built from a week ago.
echo "[dm-network] building $IMAGE from docker/staging-ops.Dockerfile"
docker build -q -f docker/staging-ops.Dockerfile -t "$IMAGE" . >/dev/null

if [[ -n "$fresh" ]]; then
  echo "[dm-network] loading schema into $URL"
  docker run --rm --network "$NET" -e DATABASE_URL="$URL" --entrypoint node "$IMAGE" scripts/pg-load-schema.mjs
fi

specs=("$@")
if [[ ${#specs[@]} -eq 0 ]]; then specs=("${DEFAULT_SPECS[@]}"); fi

echo "[dm-network] $IMAGE → $URL"
exec docker run --rm --network "$NET" -e DATABASE_TEST_URL="$URL" --entrypoint npx "$IMAGE" \
  vitest run --config vitest.datamechanics.config.ts "${specs[@]}"
