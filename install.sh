#!/usr/bin/env sh
# AIOS Team Brain installer.
#
#   curl -fsSL https://aiosbrain.dev/install.sh | sh
#
# This file is the AUDITED source. The copy served from the website is a thin bootstrap that fetches
# a pinned ref of this repo and runs the wizard below — so the logic that matters lives in git, under
# review, rather than in a mutable file on a CDN. Read it before you run it; it is short on purpose.
#
# WHAT IT DOES, AND WHAT IT REFUSES TO DO
#
#   - Never uses sudo. Everything lands in a directory you choose (default ./aios-team-brain).
#   - Never clobbers an existing install. If the directory is already a Team Brain checkout it
#     re-runs setup there; if it exists and is something else, it stops. An installer that
#     re-initialises a working instance destroys its secrets — see the rotation bug this repo fixed.
#   - Never deploys anything. The wizard's Railway path provisions only; deploys go through GitHub.
#
# Overridable: AIOS_DIR (where to install), AIOS_REF (git ref to check out), AIOS_REPO.
set -eu

REPO="${AIOS_REPO:-https://github.com/aiosbrain/aios-team-brain.git}"
REF="${AIOS_REF:-main}"
DIR="${AIOS_DIR:-aios-team-brain}"

say() { printf '  %s\n' "$*"; }
# Render the target for humans. `./$DIR` is right for a relative default but produces "./tmp/x" for
# an absolute AIOS_DIR — a path that doesn't exist and sends people looking in the wrong place.
show_dir() { case "$1" in /*) printf '%s' "$1" ;; *) printf './%s' "$1" ;; esac; }
die() { printf '\n  ✗ %s\n\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

printf '\n  AIOS Team Brain installer\n\n'

# 1. Prerequisites, named precisely — "command not found" three layers deep is not a diagnosis.
have git || die "git is required. Install it, then re-run."
have node || die "Node 20+ is required to run the setup wizard. See https://nodejs.org"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 20 ] || die "Node 20+ is required (found $(node -v)). Upgrade, then re-run."

# Docker is needed only for the local/demo targets, so this is a note rather than a hard stop —
# the wizard checks the daemon properly (not just the binary) and can still do the Railway path.
have docker || say "note: docker not found — the 'run on this machine' options will be unavailable."

# 2. Fetch, without ever overwriting something we didn't create.
if [ -e "$DIR" ]; then
  # Marker files alone are not proof: a pre-planted directory with a .git dir, a
  # scripts/setup-wizard.mjs and a hostile package.json would get `npm ci` run inside it, executing
  # arbitrary lifecycle scripts. Require the git remote to be the repo we intended to install.
  ORIGIN="$(git -C "$DIR" remote get-url origin 2>/dev/null || echo '')"
  if [ -d "$DIR/.git" ] && [ -f "$DIR/scripts/setup-wizard.mjs" ] && [ "$ORIGIN" = "$REPO" ]; then
    say "found an existing Team Brain checkout in $(show_dir "$DIR") — re-running setup there."
    say "(nothing fetched; your .env.local and secrets are left alone)"
  else
    die "$(show_dir "$DIR") already exists and is not a checkout of $REPO. Move it, or set AIOS_DIR=<other>."
  fi
else
  say "cloning $REPO @ $REF into $(show_dir "$DIR")"
  # --depth 1: this is an install, not a contribution. Contributors clone normally.
  git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR" ||
    die "clone failed. Check your network, or that '$REF' is a valid ref."
fi

cd "$DIR"

# 3. Dependencies. `npm ci` needs the lockfile; fall back for an unusual checkout.
if have npm; then
  say "installing dependencies (a minute or so)…"
  if [ -f package-lock.json ]; then npm ci --silent || die "npm ci failed."; else npm install --silent || die "npm install failed."; fi
else
  die "npm is required (it ships with Node). See https://nodejs.org"
fi

# 4. Hand over to the wizard.
#
# `< /dev/tty` is the whole reason this works under `curl … | sh`: the pipe makes THIS SCRIPT the
# shell's stdin, so the wizard would otherwise read leftover script bytes instead of the user and
# silently answer its own interview. The wizard also opens /dev/tty itself and refuses to guess when
# there is no terminal — this redirect just makes the common case work.
printf '\n'
if [ -c /dev/tty ]; then
  exec node scripts/setup-wizard.mjs < /dev/tty
else
  say "no terminal detected — run this from an interactive shell:"
  say "  cd $(show_dir "$DIR") && npm run setup"
  exit 1
fi
