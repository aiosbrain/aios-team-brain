#!/usr/bin/env sh
set -eu

# Railway's custom start command replaces the Docker ENTRYPOINT, so keep the same idempotent
# bootstrap for both existing deployments and template-created installs.
exec node scripts/staging-ops/startup-fence.mjs -- sh -c 'node docker/bootstrap.mjs && exec npm start'
