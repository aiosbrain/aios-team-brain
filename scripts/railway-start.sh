#!/usr/bin/env sh
set -eu

# Railway preDeployCommand owns migrations. Keep runtime provisioning and secrets,
# but never repeat DDL while the previous application is serving traffic.
node docker/bootstrap.mjs --schema=predeployed

# Match docker/entrypoint.sh: child-process bootstrap cannot export generated secrets.
if [ -n "${DEV_SECRETS_FILE:-}" ] && [ -f "$DEV_SECRETS_FILE" ] &&
   { [ -z "${AUTH_SECRET:-}" ] || [ -z "${SECRETS_KEY:-}" ]; }; then
  . "$DEV_SECRETS_FILE"
  export AUTH_SECRET SECRETS_KEY
fi

exec npm start
