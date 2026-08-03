#!/usr/bin/env sh
set -eu

# Existing Railway deployments keep their current startup behavior. The public template opts in
# so its first boot can create the requested team and admin after Postgres is reachable.
if [ "${AIOS_TEMPLATE_BOOTSTRAP:-false}" = "true" ]; then
  node docker/bootstrap.mjs
fi

exec npm start
