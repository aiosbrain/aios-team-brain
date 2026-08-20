#!/usr/bin/env bash
#
# db-test-up.sh — bring the shared test Postgres (compose.test.yml, port 5434) up FROM ZERO,
# every time, and never leave a half-loaded container behind.
#
# WHY THIS IS A SCRIPT AND NOT A ONE-LINER. `db:test:up` used to be:
#
#   docker compose -f compose.test.yml up -d --wait && DATABASE_URL=… npm run pg:schema
#
# `docker compose up` on an ALREADY-RUNNING container is a no-op, so the tmpfs data dir is only
# wiped when the container is recreated — not on every `up`, which is what the compose comment and
# the docs both claimed. The schema load therefore replayed onto whatever the last run left behind,
# which is two separate failures:
#
#   1. It is not the from-zero replay proof the command is relied on for (CLAUDE.md, docs
#      /ARCHITECTURE.md §"Add a migration"). A dirty DB can hide a migration that only works
#      because a previous run's DDL was already there.
#   2. It can ABORT part-way. The data-mechanics tier's PRET-6 test
#      (test/datamechanics/pret6-precondition.datamechanics.test.ts) re-adds the retired
#      `teams.access_enforcement` column with its historical `'permissive'` default so the
#      migration's own text can be executed against a realistic fleet — and the harness truncates
#      ROWS, not DDL, so that column outlives the run. Add any surviving `teams` row (an
#      interrupted run, a seed script) and the next replay hits the production guard in
#      20260818210000_pret6_retire_access_enforcement.sql:
#
#        schema load failed: PRET-6 refused: permissive team(s) remain — flip them first
#
#      That guard is CORRECT and stays exactly as it is: it protects a real deployed fleet from
#      losing the flip-readiness gate (the H-VANISH hazard, docs/RELEASE-NOTES-pret6.md). The bug
#      was never the guard — it was routing a *local test-DB bring-up* through a *production
#      upgrade* path with no way back to a clean state. The abort left the container UP, healthy,
#      and missing every migration ordered after the guard: callers then got confusing
#      "column … does not exist" errors instead of a clean connection refusal.
#
# So: reset first (the name `up` then means what it says and is re-runnable against any state),
# and on a schema-load failure tear the container down so the only two possible outcomes are
# "up with a complete schema" or "not up at all".
#
# COST: the reset is unconditional and destructive by design — the shared :5434 DB is a scratch
# resource and this command has always been documented as resetting it. If you need a DB that
# survives someone else's `db:test:up`, use `npm run test:datamechanics:iso`
# (scripts/dm-isolated.sh), which gives your worktree its own container on its own port.
#
# Usage: npm run db:test:up
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="compose.test.yml"
DB_URL="postgres://app:app@localhost:5434/app_test"

teardown() { docker compose -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true; }

# Any failure removes the container: the only two outcomes are "up with a complete schema" or
# "not up at all" — never "up, healthy, and missing migrations". `up -d --wait` is covered too;
# it returns non-zero when the healthcheck never goes green but leaves the container behind.
fail() {
  local rc="${2:-1}"
  echo "[db:test:up] $1 FAILED (exit $rc) — removing the container so nothing is left half-loaded." >&2
  teardown
  exit "$rc"
}

echo "[db:test:up] resetting the shared test Postgres on :5434 (destructive — a parallel run against it loses its data; use 'npm run test:datamechanics:iso' for a private DB)"
teardown

# Prove the reset actually happened. A tolerated-but-failed `down` would leave the old container
# running, the next `up` would no-op on it, and the schema would replay onto a dirty DB — the exact
# defect this script exists to remove, reintroduced silently. Loud beats silent.
if [ -n "$(docker compose -f "$COMPOSE_FILE" ps -aq)" ]; then
  echo "[db:test:up] reset FAILED — a container from compose.test.yml survived 'down -v'. Remove it by hand (docker rm -f -v aios-brain-test-postgres-1) and re-run." >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" up -d --wait || fail "container start" $?

DATABASE_URL="$DB_URL" npm run pg:schema || fail "schema load" $?
