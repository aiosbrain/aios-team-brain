#!/usr/bin/env sh
set -eu

# Railway's custom start command replaces the Docker ENTRYPOINT, so keep the same idempotent
# bootstrap for both existing deployments and template-created installs.
node docker/bootstrap.mjs

exec npm start
