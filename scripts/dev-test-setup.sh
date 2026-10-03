#!/usr/bin/env bash
# dev-test-setup.sh — one command to set up a clean manual e2e test:
#   reset+seed the brain (with login-able demo users) → build a wired demo spoke
#   → print the local dashboard login link and the exact aios commands to run.
#
# Prereqs: the ephemeral test Postgres (`npm run db:test:up`, port 5434) and ONE dev server started
# with `npm run dev:login` (AIOS_DEV_LOGIN=1, bound to 127.0.0.1, port 3000), pointed at the SAME
# test DB (DATABASE_URL=postgres://app:app@localhost:5434/app_test) — never a real/prod DB.
# Plain `npm run dev` serves push/query but leaves the login link a 404: the dev-login bypass is off
# unless the server was started with it. This script never enables it and never requests it.
#
# NOTE: the reset path below runs `npm run db:test:up`, which DESTROYS and recreates the container
# (scripts/db-test-up.sh) — so an already-running dev server loses every pooled connection and
# reconnects. That is normally invisible (node-postgres evicts dead clients), but if the dev server
# is mid-request you may see one transient error. `--no-reset` skips it.
#
# Usage:
#   npm run test:setup            # full reset + seed + spoke
#   npm run test:setup -- --no-reset   # keep existing data, just re-mint key + spoke
#
# Env: OPS_DIR (default ~/Projects/aios-workspace), SPOKE (default /tmp/acme-workspace),
#      APP_URL (default http://127.0.0.1:3000) — the brain URL wired into the spoke and checked for
#        API availability. It is never used to build the login link.
#      DEV_LOGIN_PORT (default 3000) — this helper only: the port of the local dev server, printed in
#        the login link and its launch command. For another port start the server with
#        `npm run dev:login -- --port <port>` and point APP_URL at the same port.

set -euo pipefail
BRAIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OPS_DIR="${OPS_DIR:-$HOME/Projects/aios-workspace}"
SPOKE="${SPOKE:-/tmp/acme-workspace}"
APP_URL="${APP_URL:-http://127.0.0.1:3000}"
DB_PORT="${DB_PORT:-5434}"
RESET=1
[[ "${1:-}" == "--no-reset" ]] && RESET=0

cd "$BRAIN_DIR"
[[ -f .env.local ]] || { echo "missing .env.local — copy .env.example and fill it"; exit 1; }
set -a; source .env.local; set +a
# Target the ephemeral test DB, never whatever .env.local's DATABASE_URL points at.
export DATABASE_URL="postgres://app:app@localhost:${DB_PORT}/app_test"
[[ -d "$OPS_DIR" ]] || { echo "aios-workspace not found at $OPS_DIR (set OPS_DIR=)"; exit 1; }
# Canonical decimal 1–65535 only (no sign, no leading zero): it is printed into a URL and a command.
DEV_LOGIN_PORT="${DEV_LOGIN_PORT:-3000}"
if [[ ! "$DEV_LOGIN_PORT" =~ ^[1-9][0-9]{0,4}$ ]] || (( DEV_LOGIN_PORT > 65535 )); then
  echo "DEV_LOGIN_PORT must be a port number 1-65535 (set DEV_LOGIN_PORT=)"; exit 1
fi

if [[ "$RESET" == "1" ]]; then
  echo "── resetting + migrating the brain DB (ephemeral test Postgres) …"
  npm run db:test:up >/dev/null
fi

echo "── seeding demo team (creates login-able users + demo data + API key) …"
npx tsx --conditions react-server scripts/seed-demo.ts | grep -E "tasks materialized|decisions materialized|assertions" || true
KEY="$(cat "$BRAIN_DIR/.aios-demo-key" 2>/dev/null || true)"
[[ -n "$KEY" ]] || { echo "could not read .aios-demo-key — seed may have failed"; exit 1; }

echo "── building wired demo spoke at $SPOKE …"
bash "$OPS_DIR/scripts/demo-spoke.sh" \
  --slug acme-workspace --output "$SPOKE" \
  --team-id demo --brain-url "$APP_URL" \
  --api-key "$KEY" --member alex >/dev/null
echo "   spoke ready (content across team / external / admin tiers)."

# Stable, re-usable local login (mints+verifies per request). Always the literal loopback address
# and the explicit local port — never APP_URL or a forwarded header: the route admits only a local
# authority on the server's own port.
LOGIN_URL="http://127.0.0.1:${DEV_LOGIN_PORT}/auth/dev-login?email=alex@demo.aios.local&next=/t/demo"
LOGIN_SERVER="npm run dev:login"
[[ "$DEV_LOGIN_PORT" == "3000" ]] || LOGIN_SERVER="npm run dev:login -- --port $DEV_LOGIN_PORT"

# Is a server answering the API? Availability only: it says nothing about whether the dev-login
# bypass is on, and the session-minting route is never requested to find out.
DEV_UP=0
curl -s -o /dev/null --max-time 2 "$APP_URL/api/v1/items" && DEV_UP=1 || true

cat <<BANNER

────────────────────────────────────────────────────────────────────
  AIOS manual test — ready.
────────────────────────────────────────────────────────────────────

  Dashboard login (no email, re-usable — works ONLY on a server started with the bypass):
    1. start ONE dev server:   $LOGIN_SERVER
       (AIOS_DEV_LOGIN=1, bound to 127.0.0.1; under plain 'npm run dev' this link is a 404)
    2. open in a browser on this machine:
       $LOGIN_URL

  Contributor CLI (spoke is pre-wired; key is in its .env):
    export PATH="$OPS_DIR/bin:\$PATH"
    cd $SPOKE
    aios status         # charter/tasks 'new'; pricing.md 'blocked' (admin)
    aios push           # push team/external tiers
    aios push           # → nothing to push (idempotent)
    aios query "what is the governance gate policy?"
    aios pull-bundle    # OKF link graph → .aios/bundle.json
    aios graph          # traverse the local link graph (offline)

BANNER

if [[ "$DEV_UP" != "1" ]]; then
  echo "  ⚠ no server detected on $APP_URL — run '$LOGIN_SERVER' before login/push/query/pull-bundle."
  echo ""
fi
