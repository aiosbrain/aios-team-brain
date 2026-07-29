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

# `exec` matters: the server must become PID 1 so `docker compose stop` / Ctrl-C signal Next
# directly instead of killing this wrapper and orphaning it.
exec "$@"
