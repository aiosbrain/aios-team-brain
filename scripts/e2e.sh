#!/bin/bash
# e2e.sh — full cross-repo verification of the AIOS sync loop.
#
# Prereqs: supabase start (this repo), .env.local populated, `npm run dev` NOT
# already running on :3000, and a checkout of aios-workspace for the CLI.
#
# Loop verified: seed → issue key → aios push (contributor CLI) → idempotent
# re-push → pull → rows materialized → admin-tier 422 → NL query cites sources.

set -euo pipefail

BRAIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPS_DIR="${OPS_DIR:-$HOME/Projects/aios-workspace}"
PORT="${PORT:-3000}"
DB_PORT="${DB_PORT:-55422}"

cd "$BRAIN_DIR"
set -a; source .env.local; set +a

echo "── 1. reset + migrate + seed"
supabase db reset >/dev/null
SEED_OUT=$(npx tsx --conditions react-server scripts/seed-demo.ts)
echo "$SEED_OUT" | grep -E "tasks materialized|decisions materialized|assertions"
KEY=$(echo "$SEED_OUT" | grep -oE 'aios_[A-Za-z0-9]+_[A-Za-z0-9_-]+')

echo "── 2. start dev server"
npm run dev > /tmp/e2e-dev.log 2>&1 &
DEV_PID=$!
trap 'kill $DEV_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/v1/items" || true)
  [ "$code" = "401" ] && break
  sleep 1
done
[ "$code" = "401" ] || { echo "FAIL: API not up (got $code)"; exit 1; }
echo "API up (401 unauthenticated ✓)"

echo "── 3. scaffold contributor repo + push"
rm -rf /tmp/e2e-spoke
"$OPS_DIR/scripts/scaffold-project.sh" --slug e2e-spoke --stakeholder "E2E Co" \
  --lead alex --members "alex,sam" --team-id demo \
  --brain-url "http://127.0.0.1:$PORT" --output /tmp/e2e-spoke >/dev/null
cat > /tmp/e2e-spoke/02-deliverables/e2e-doc.md << 'EOF'
---
status: review
owner: alex
access: team
---
# E2E deliverable

The governance review gates run in advisory mode for now.
EOF
printf '| T-90 | E2E test task | alex | in_progress | sprint-1 | |\n' >> /tmp/e2e-spoke/03-status/tasks.md

export AIOS_API_KEY="$KEY" AIOS_MEMBER=alex
node "$OPS_DIR/scripts/aios.mjs" push --repo /tmp/e2e-spoke
echo "── 4. idempotent re-push"
node "$OPS_DIR/scripts/aios.mjs" push --repo /tmp/e2e-spoke | grep -q "nothing to push" \
  && echo "no-op re-push ✓" || { echo "FAIL: re-push not idempotent"; exit 1; }

echo "── 5. materialization"
TASKS=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -t -A \
  -c "select count(*) from tasks t join projects p on p.id=t.project_id where p.slug='e2e-spoke'")
[ "$TASKS" -ge 1 ] && echo "e2e-spoke tasks materialized: $TASKS ✓" \
  || { echo "FAIL: no tasks materialized"; exit 1; }

echo "── 6. admin tier rejected"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/v1/items" \
  -H "Authorization: Bearer $KEY" -H "X-AIOS-Team: demo" -H "Content-Type: application/json" \
  -d '{"project":"e2e-spoke","path":"x.md","kind":"artifact","content_sha256":"'"$(printf x | shasum -a 256 | cut -d' ' -f1)"'","actor":"alex","access":"admin","frontmatter":{},"body":"x"}')
[ "$CODE" = "422" ] && echo "admin push → 422 ✓" || { echo "FAIL: admin got $CODE"; exit 1; }

echo "── 7. pull"
node "$OPS_DIR/scripts/aios.mjs" pull --repo /tmp/e2e-spoke

echo "── 8. ingestion sidecar (Organ 2): connector backfill"
ING_BIN="$BRAIN_DIR/ingestion/.venv/bin/aios-ingest"
if [ -x "$ING_BIN" ]; then
  export BRAIN_URL="http://127.0.0.1:$PORT" AIOS_API_KEY="$KEY" AIOS_TEAM=demo
  ING_OPTS=(--source github --opt repo=octocat/Hello-World --opt 'path_glob=*' --project github)
  [ -n "${GITHUB_TOKEN:-}" ] && ING_OPTS+=(--opt "token=$GITHUB_TOKEN")
  "$ING_BIN" backfill "${ING_OPTS[@]}" | tee /tmp/e2e-ingest.out
  grep -qE '[1-9][0-9]* created|[1-9][0-9]* unchanged' /tmp/e2e-ingest.out \
    || { echo "FAIL: backfill pushed nothing"; exit 1; }
  ITEMS=$(PGPASSWORD=postgres psql -h 127.0.0.1 -p "$DB_PORT" -U postgres -d postgres -t -A \
    -c "select count(*) from items i join projects p on p.id=i.project_id where p.slug='github'")
  [ "$ITEMS" -ge 1 ] && echo "github-sourced items materialized: $ITEMS ✓" \
    || { echo "FAIL: no github-sourced items"; exit 1; }
  echo "── 8b. ingestion idempotent re-run"
  "$ING_BIN" backfill "${ING_OPTS[@]}" | grep -q "unchanged" \
    && echo "ingest re-run idempotent ✓" || { echo "FAIL: ingest not idempotent"; exit 1; }
else
  echo "SKIPPED (no ingestion venv — run: cd ingestion && uv venv && uv pip install -e .)"
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "── 9. NL query (live Claude)"
  node "$OPS_DIR/scripts/aios.mjs" query "What did we decide about governance review gates?" \
    --repo /tmp/e2e-spoke | tee /tmp/e2e-query.out
  grep -q "advisory" /tmp/e2e-query.out && echo "query grounded ✓" \
    || { echo "FAIL: query did not cite the advisory-mode decision"; exit 1; }
else
  echo "── 9. NL query SKIPPED (no ANTHROPIC_API_KEY)"
fi

echo ""
echo "E2E PASSED"
