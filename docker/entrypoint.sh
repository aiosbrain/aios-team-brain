#!/usr/bin/env sh
# Prepare the database, then hand off to the container's CMD (`npm start`).
set -eu

node /app/docker/bootstrap.mjs

# bootstrap runs as a child process, so the secrets it generated cannot reach us through its
# environment — it writes them here instead. Sourcing before exec is what actually puts
# AUTH_SECRET / SECRETS_KEY in front of the server.
if [ -n "${DEV_SECRETS_FILE:-}" ] && [ -f "$DEV_SECRETS_FILE" ]; then
  . "$DEV_SECRETS_FILE"
  export AUTH_SECRET SECRETS_KEY
fi

# `exec` matters: this wrapper must not linger between the container's signals and the fence.
#
# tini is the container's PID 1 REAPER, and it is here for the same reason it is in
# scripts/railway-start.sh: the fence supervises a payload chain, and an orphaned grandchild under a
# non-reaping PID 1 stays a zombie whose process group keeps answering `kill(-pgid, 0)` — which the
# fence's strict group-gone verification can only read as a live workload, so it holds its shared
# lock and refuses a stop that already completed. `-s` (subreaper) so this holds even where this
# script is not itself PID 1. tini forwards TERM/INT to the fence and propagates its exit status, so
# `docker compose stop` / Ctrl-C still reach the supervisor exactly as before.
exec /usr/bin/tini -s -- node /app/scripts/staging-ops/startup-fence.mjs -- "$@"
