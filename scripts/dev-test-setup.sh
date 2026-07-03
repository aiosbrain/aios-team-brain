#!/usr/bin/env bash
# dev-test-setup.sh — one command to set up a clean manual e2e test:
#   reset+seed the brain (with login-able demo users) → build a wired demo spoke
#   → print a one-click dashboard login link and the exact aios commands to run.
#
# Prereqs: the ephemeral test Postgres (`npm run db:test:up`, port 5434) and
# `npm run dev` (port 3000) both up, with `npm run dev` pointed at the SAME test DB
# (DATABASE_URL=postgres://app:app@localhost:5434/app_test) — never a real/prod DB.
#
# Usage:
#   npm run test:setup            # full reset + seed + spoke
#   npm run test:setup -- --no-reset   # keep existing data, just re-mint key + spoke
#
# Env: OPS_DIR (default ~/Projects/aios-workspace), SPOKE (default /tmp/acme-workspace)

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

# Stable, re-usable, host-correct one-click login (mints+verifies per request).
LOGIN_URL="$APP_URL/auth/dev-login?email=alex@demo.aios.local&next=/t/demo"

# Is the dev server up?
DEV_UP=0
curl -s -o /dev/null --max-time 2 "$APP_URL/api/v1/items" && DEV_UP=1 || true

cat <<BANNER

────────────────────────────────────────────────────────────────────
  AIOS manual test — ready.
────────────────────────────────────────────────────────────────────

  Dashboard login (open in browser — no email, re-usable, never stale):
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
  echo "  ⚠ dev server not detected on $APP_URL — run 'npm run dev' before push/query/pull-bundle."
  echo ""
fi
