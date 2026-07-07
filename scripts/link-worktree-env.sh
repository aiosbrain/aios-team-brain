#!/usr/bin/env bash
#
# Hydrate a freshly created git worktree with the local, gitignored dev config that
# `git worktree add` can't bring along. `.envrc`, `.env.local`, and `.env.keys` all match
# `.gitignore`'s `.env*` pattern, so a new worktree checkout starts with none of them:
#   - `.env.local` (dotenvx-encrypted: DATABASE_URL, AUTH_SECRET, RESEND_API_KEY, APP_URL, ...)
#     is decrypted at request time by Next's own `@next/env` loader using the sibling
#     `.env.keys` — both files just need to physically exist in cwd for `npm run dev` /
#     `next build` to pick them up. Neither direnv nor the shell is involved in this part.
#   - `.envrc` is the separate, lower-privilege Tessera root cascade (shared keys like
#     ANTHROPIC_API_KEY) — this DOES need direnv active to reach the shell/process env.
# Symlinks both sets (plus node_modules) from the PRIMARY checkout — resolved via
# `git rev-parse --git-common-dir`, so this needs no arguments and works from any worktree —
# into the current directory, then runs `direnv allow` for the second piece. Idempotent: safe
# to re-run.
#
# Run from INSIDE the new worktree, right after `git worktree add`:
#   cd ../aios-team-brain-<task>
#   ../aios-team-brain/scripts/link-worktree-env.sh

set -euo pipefail

common_dir="$(git rev-parse --git-common-dir)"
main_worktree="$(cd "$(dirname "$common_dir")" && pwd)"
here="$(pwd)"

if [[ "$main_worktree" == "$here" ]]; then
  echo "Already in the primary checkout ($here) — nothing to hydrate."
  exit 0
fi

for name in node_modules .envrc .env.local .env.keys .env; do
  src="$main_worktree/$name"
  [[ -e "$src" ]] || continue

  if [[ -e "$here/$name" && ! -L "$here/$name" ]]; then
    echo "skip $name — a real file already exists here (not overwriting)"
    continue
  fi

  ln -sfn "$src" "$here/$name"
  echo "linked $name -> $src"
done

if command -v direnv >/dev/null 2>&1; then
  direnv allow "$here" || echo "direnv allow failed — run it manually if the cascade doesn't auto-load"
else
  echo "direnv not installed — secrets are linked but won't auto-load into the shell"
fi
