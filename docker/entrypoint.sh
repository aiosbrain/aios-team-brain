#!/usr/bin/env sh
# Prepare the database, then hand off to the container's CMD (`npm start`).
# `exec` matters: the server must become PID 1 so `docker compose stop` / Ctrl-C signal
# Next directly instead of killing this wrapper and orphaning it.
set -eu

node /app/docker/bootstrap.mjs

exec "$@"
