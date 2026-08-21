#!/usr/bin/env bash
#
# STAGING-1 — copy PRODUCTION's Postgres into STAGING's own Postgres, so a branch can be looked at
# against real data. Spec: docs/design/staging-prod-shaped-data.md. Runbook: docs/OPS.md §"Staging
# refresh".
#
# THE DANGEROUS DIRECTION is the reverse of the intended one. `pg_restore --clean` drops every object
# it is about to recreate, so pointing the TARGET at production destroys production. Every refusal in
# scripts/staging-refresh-decision.mjs exists for that sentence. The decision is pure and unit-tested
# there rather than written here, because a guard living only in bash is a guard nothing runs until
# the day it matters.
#
# WHAT THIS SCRIPT DELIBERATELY DOES NOT DO:
#   * It does not mutate Railway. Not variables, not deploys, nothing. It touches one database and
#     writes one dump file. The obvious future convenience edit — "have it set the staging flags for
#     you" — is what a guard forbids, because a script that can set variables can point staging at
#     production.
#   * It does not sanitise the target after restoring. Credentials are excluded from the DUMP instead:
#     a crash between a committed restore and a post-hoc sanitation would leave staging live with
#     prod-shaped rows and usable credentials, and "the next run refuses" is no help once the harmful
#     state exists.
#   * It never passes the pg_restore database-recreate flag. Recreating the database would drop the
#     staging marker with it, and the marker is the only thing that distinguishes a legal target from
#     production.
#
# USAGE
#   STAGING_REFRESH_SOURCE_URL=<prod public URL, read-only use> \
#   STAGING_REFRESH_TARGET_URL=<staging public URL> \
#     bash scripts/staging-refresh.sh
#
# Optional: PG_BIN=/path/to/postgres/bin to pin the client binaries (see the version refusal below).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DECIDE="$REPO_ROOT/scripts/staging-refresh-decision.mjs"

# Every libpq call goes through this. `PGHOSTADDR` redirects a connection with the URL untouched —
# measured: a URL naming a nonexistent host connected to 127.0.0.1 with PGHOSTADDR set — so an ambient
# variable in the operator's shell could send a `--clean` restore to production while every refusal
# above read the innocent hostname. `psql -X` for the same reason one level up: a `\c other_db` in
# ~/.psqlrc would move the session after the marker was read. The list is exported by the decision
# module so the guard can prove the script scrubs exactly what the module declares.
PG_SCRUB=(env)
while IFS= read -r pg_var; do
  [ -n "$pg_var" ] && PG_SCRUB+=(-u "$pg_var")
done < <(node "$DECIDE" scrubbed-env)
if [ ${#PG_SCRUB[@]} -le 1 ]; then
  echo "staging-refresh REFUSED: the libpq environment scrub list came back EMPTY." >&2
  echo "  Without it, PGHOSTADDR/PGSERVICE can point this run at a database no refusal here inspected." >&2
  exit 1
fi

# No defaults, on purpose (spec criterion 6). The `:-` below is an EMPTY fallback so `set -u` does not
# abort before the refusal can be printed with its explanation — it is not a default value, and a
# guard asserts that these two never acquire one.
SOURCE_URL="${STAGING_REFRESH_SOURCE_URL:-}"
TARGET_URL="${STAGING_REFRESH_TARGET_URL:-}"

# A decision is only an approval when it SAYS SO. Exit 0 alone is not enough: the decision CLI once
# no-opped entirely — printing nothing, exiting 0 — whenever it ran from a symlinked path or one with a
# space in it, because its entry guard compared unresolved path strings. Every refusal was dead and this
# script would have read the silence as a green light. Requiring a positive token means any future
# spelling of that bug stops the refresh instead of waving it through.
decide() {
  local out
  if ! out="$(node "$DECIDE" "$@")"; then
    return 1
  fi
  case "$out" in
    *"staging-refresh: DECISION OK"*) return 0 ;;
    *)
      echo "staging-refresh REFUSED: the decision step produced no verdict (exit 0, no ack)." >&2
      echo "  Refusing rather than treating silence as approval." >&2
      return 1
      ;;
  esac
}

# ── Layer 1: connection-free refusals ───────────────────────────────────────────────────────────
# Missing URLs and same-host must die BEFORE a socket is opened: the copy-paste case is both URLs
# pointing at production, and "we refused, but only after logging into prod" is a worse story.
decide preflight --source "$SOURCE_URL" --target "$TARGET_URL"

# ── Readings the remaining refusals need ────────────────────────────────────────────────────────
# `psql` from PATH is fine for reading a version: only pg_dump refuses a newer server.
read_server_major() {
  local url="$1"
  "${PG_SCRUB[@]}" psql -X "$url" -tAc "select current_setting('server_version_num')::int / 10000" 2>/dev/null | tr -d '[:space:]'
}

SOURCE_MAJOR="$(read_server_major "$SOURCE_URL" || true)"
TARGET_MAJOR="$(read_server_major "$TARGET_URL" || true)"

# Binary resolution: an explicit override, else a Homebrew keg matching the SOURCE server's major,
# else whatever is on PATH — and if that is too old, the version refusal below names the remedy
# rather than letting pg_dump fail with its own less actionable message.
if [[ -n "${PG_BIN:-}" ]]; then
  PG_DUMP="$PG_BIN/pg_dump"
  PG_RESTORE="$PG_BIN/pg_restore"
elif [[ -n "$SOURCE_MAJOR" && -x "/opt/homebrew/opt/postgresql@$SOURCE_MAJOR/bin/pg_dump" ]]; then
  PG_DUMP="/opt/homebrew/opt/postgresql@$SOURCE_MAJOR/bin/pg_dump"
  PG_RESTORE="/opt/homebrew/opt/postgresql@$SOURCE_MAJOR/bin/pg_restore"
else
  PG_DUMP="$(command -v pg_dump || true)"
  PG_RESTORE="$(command -v pg_restore || true)"
fi

CLIENT_MAJOR=""
if [[ -n "$PG_DUMP" && -x "$PG_DUMP" ]]; then
  CLIENT_MAJOR="$("${PG_SCRUB[@]}" "$PG_DUMP" --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
fi

# Does a database carry the staging marker? An error reads as UNKNOWN, and unknown is a refusal.
# The `[[ … ]] && VAR=…` pairs below look like the classic `set -e` footgun and are not: bash exempts
# every member of an && list except the one after the final `&&`, so a false test assigns nothing and
# the function returns its default. Verified by running it, not by reading the manual — a silent exit
# here would swallow the very refusal that names the remedy.
read_marker() {
  local url="$1" raw answer="unknown"
  if raw="$("${PG_SCRUB[@]}" psql -X "$url" -tAc "select to_regclass('public.staging_marker') is not null" 2>/dev/null)"; then
    raw="$(echo "$raw" | tr -d '[:space:]')"
    [[ "$raw" == "t" ]] && answer="true"
    [[ "$raw" == "f" ]] && answer="false"
  fi
  echo "$answer"
}

MARKER="$(read_marker "$TARGET_URL")"
# Read it on the SOURCE too. A production database that once acquired the marker by accident (an
# operator with the target variable mis-set while declaring it) would make the target check pass for a
# swapped pair forever, and nothing else in this repo would ever notice. The source of a legitimate
# refresh is production, which has no marker — so a marked source means the two urls are swapped.
SOURCE_MARKER="$(read_marker "$SOURCE_URL")"

# ── Layer 2: the full decision ──────────────────────────────────────────────────────────────────
decide check \
  --source "$SOURCE_URL" \
  --target "$TARGET_URL" \
  --marker "$MARKER" \
  --source-marker "$SOURCE_MARKER" \
  --client-major "${CLIENT_MAJOR:-0}" \
  --server-major "${SOURCE_MAJOR:-0}"

if [[ -n "$TARGET_MAJOR" && -n "$SOURCE_MAJOR" && "$TARGET_MAJOR" != "$SOURCE_MAJOR" ]]; then
  echo "staging-refresh: NOTE — source server is major $SOURCE_MAJOR, target is major $TARGET_MAJOR." >&2
  echo "  A dump from a newer server does not restore into an older one; verify before trusting a partial restore." >&2
fi

# ── Dump ────────────────────────────────────────────────────────────────────────────────────────
# The dump holds prod items, member emails and api-key hashes. It is written to a private temp file and
# REMOVED on every exit path — leaving it in /tmp is a copy of production sitting on a laptop with no
# expiry. `STAGING_REFRESH_DUMP` keeps it deliberately (for debugging a failed restore) and is then the
# operator's to delete; that is documented in docs/OPS.md §11 rather than left as folklore.
if [[ -n "${STAGING_REFRESH_DUMP:-}" ]]; then
  DUMP_FILE="$STAGING_REFRESH_DUMP"
  KEEP_DUMP=1
else
  # `mktemp` creates the file it names; naming the dump `<that>.dump` would leave the original behind
  # empty. Use the file mktemp actually made.
  DUMP_FILE="$(mktemp -t staging-refresh)"
  KEEP_DUMP=0
fi
cleanup() {
  [[ "$KEEP_DUMP" -eq 0 && -f "$DUMP_FILE" ]] && rm -f "$DUMP_FILE"
  return 0
}
trap cleanup EXIT

# A while-read loop, not `mapfile`: macOS ships bash 3.2, where `mapfile`/`readarray` do not exist.
# This script's own operator is on that bash, so the convenient spelling would have aborted here —
# AFTER connecting to production — which is the same shape as the pg_dump version trap the refusals
# above exist for. A guard pins that no bash-4-only builtin creeps back in.
EXCLUDE_ARGS=()
while IFS= read -r line; do
  [ -n "$line" ] && EXCLUDE_ARGS+=("$line")
done < <(node "$DECIDE" exclude-args)
if [ ${#EXCLUDE_ARGS[@]} -eq 0 ]; then
  echo "staging-refresh REFUSED: the exclusion list came back EMPTY." >&2
  echo "  An empty list would dump every reversible-secret table's data into staging. Refusing." >&2
  exit 1
fi

echo "staging-refresh: dumping source → $DUMP_FILE"
echo "staging-refresh: excluding table DATA: ${EXCLUDE_ARGS[*]}"
"${PG_SCRUB[@]}" "$PG_DUMP" --format=custom --no-owner "${EXCLUDE_ARGS[@]}" --file "$DUMP_FILE" "$SOURCE_URL"

# ── Restore ─────────────────────────────────────────────────────────────────────────────────────
# Flags per docs/OPS.md §Restore. `--no-owner` because Railway roles differ across environments.
# The staging marker survives this because pg_restore drops only what the archive contains, and the
# marker exists in no archive — which is why it must never be added to postgres/schema.sql.
# `--single-transaction`: without it a restore that fails halfway leaves staging LIVE with a half-dropped,
# half-restored database — the drops have already committed. Wrapped, a failure rolls back to whatever
# staging had before, which is a working environment rather than a broken one. It implies
# --exit-on-error, which is the direction we want: a partial success must not read as a refresh.
echo "staging-refresh: restoring into target (destructive to the target's copies of dumped objects)"
"${PG_SCRUB[@]}" "$PG_RESTORE" --single-transaction --clean --if-exists --no-owner --dbname "$TARGET_URL" "$DUMP_FILE"

# ── Replay migrations that postdate the dump ────────────────────────────────────────────────────
# From a PLAIN SHELL, never through the Railway CLI: scripts/pg-load-schema.mjs calls
# assertServiceIdentity before it connects, which no-ops off-Railway but REFUSES under a Railway shell
# (that injects a non-AIOS service name plus the project marker). docs/OPS.md §Restore says to use a
# Railway shell and is wrong for this case.
echo "staging-refresh: replaying schema + migrations against the target"
DATABASE_URL="$TARGET_URL" npm --prefix "$REPO_ROOT" run pg:schema

node "$DECIDE" completion
