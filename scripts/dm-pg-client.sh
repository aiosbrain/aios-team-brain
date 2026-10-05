#!/usr/bin/env bash
#
# Run ONE PostgreSQL client tool (pg_dump | pg_restore | psql) for the isolated data-mechanics tier,
# from the SAME image as this worktree's dm server container — so the client always matches the
# server's major version, whatever the host happens to have installed.
#
# WHY: the staging paired-restore specs spawn the real `pg_dump`/`pg_restore`/`psql`. `pg_dump`
# refuses a server newer than itself, and a developer machine's client is whatever its package
# manager last installed (Homebrew `postgresql@14` here, against the tier's `postgres:16`). CI pins
# `postgresql-client-16` in its job container; locally the matching tools are the ones already inside
# the image the dm server runs from. Nothing on the host is installed, upgraded or modified.
#
# HOW: `scripts/dm-isolated.sh` puts three tiny shims for this script first on PATH — only when the
# host tools are missing or a different major — and exports the three variables below. The tool runs
# in a throwaway container that
#   • is created from the dm server container's exact image id (never a re-pulled tag),
#   • shares that container's network namespace, where the server is `localhost:5432`,
#   • sees the host temp root at the same path, which is where the specs put their archives.
# It can therefore reach exactly one database server: this worktree's throwaway dm one.
#
# Not for direct use, and never pointed at anything but the dm container.
set -euo pipefail

tool="${1:?usage: dm-pg-client.sh <pg_dump|pg_restore|psql> [args...]}"
shift
case "$tool" in
  pg_dump | pg_restore | psql) ;;
  *) echo "[dm-pg-client] unsupported tool: $tool" >&2; exit 64 ;;
esac

: "${AIOS_DM_PG_CONTAINER:?[dm-pg-client] AIOS_DM_PG_CONTAINER is not set (run through scripts/dm-isolated.sh)}"
: "${AIOS_DM_PG_HOST_PORT:?[dm-pg-client] AIOS_DM_PG_HOST_PORT is not set (run through scripts/dm-isolated.sh)}"
: "${AIOS_DM_PG_IMAGE:?[dm-pg-client] AIOS_DM_PG_IMAGE is not set (run through scripts/dm-isolated.sh)}"
: "${AIOS_DM_PG_TMP:?[dm-pg-client] AIOS_DM_PG_TMP is not set (run through scripts/dm-isolated.sh)}"

# The specs address the server by its host-published port. Inside the server's network namespace
# that same server is port 5432. ONLY a URL naming this container's own published port is rewritten;
# any other destination is passed through untouched and is simply unreachable from in here.
args=()
for arg in "$@"; do
  arg="${arg//@localhost:${AIOS_DM_PG_HOST_PORT}\//@localhost:5432/}"
  arg="${arg//@127.0.0.1:${AIOS_DM_PG_HOST_PORT}\//@127.0.0.1:5432/}"
  args+=("$arg")
done

# `--user`: archives and listings are written into the caller's temp directory as the caller, so the
# spec can read and remove them on Linux too. `--init`: a terminated tool does not outlive its
# bounded-process parent as an unreaped child. The `${args[@]+…}` form is for bash 3.2 under `set -u`.
exec docker run --rm --init \
  --network "container:${AIOS_DM_PG_CONTAINER}" \
  --user "$(id -u):$(id -g)" \
  -v "${AIOS_DM_PG_TMP}:${AIOS_DM_PG_TMP}" \
  "$AIOS_DM_PG_IMAGE" \
  "$tool" ${args[@]+"${args[@]}"}
