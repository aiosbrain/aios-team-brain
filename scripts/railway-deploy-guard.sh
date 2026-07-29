#!/usr/bin/env bash
#
# PreToolUse(Bash) guard — refuses Railway CLI deploy/destroy commands from this repo.
#
# WHY THIS EXISTS: `railway up` / `railway redeploy` deploy the CURRENT directory's code to
# whatever Railway project the directory is *linked* to (link lives in ~/.railway/config.json,
# keyed by absolute path). A Conductor worktree that drifted to the wrong link — an
# aios-team-brain worktree linked to the **Kula** project — meant a `railway up` shipped this
# repo's code into Kula's production service and took it down.
#
# THE RULE: production deploys happen ONLY by merging to `main` → Railway's GitHub integration
# auto-deploys AIOS → aios-team-brain. That path is bound in the Railway dashboard and CANNOT
# target another project, so it is impossible to deploy aios code to Kula that way.
#
# Against an EXISTING instance the CLI is read-only (status, logs, variables, `deployment list`).
# Provisioning a BRAND-NEW project is the one sanctioned exception — `railway init`/`add`/
# `variables`/`domain`/`run`, as run by `scripts/setup.mjs`. Those verbs still write, so their
# safety does not come from this hook: setup.mjs pins the project it created and re-verifies the
# link before every write (`assertPinnedTarget`), because a drifted `variables --set` would
# clobber another project's environment exactly the way a drifted `up` clobbered Kula's code.
# The shared policy — and the tests that hold THIS script to it — live in
# scripts/railway-policy.mjs and test/railway-policy.test.ts.
#
# Reads the PreToolUse JSON on stdin; exits 2 (block) if the command invokes a forbidden verb.

set -euo pipefail

input="$(cat)"

# Pull out the proposed shell command (robust JSON parse); fall back to the raw payload.
cmd="$(printf '%s' "$input" | python3 -c 'import sys,json
try: sys.stdout.write(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: pass' 2>/dev/null || true)"
[ -z "${cmd:-}" ] && cmd="$input"

# Block only an actual `railway <verb>` INVOCATION — `railway` at a command boundary (start of a
# line/command, or after whitespace/`;`/`|`/`&`/`(`, e.g. `cd other && railway up`). A mention in
# docs/strings/commit messages (e.g. a backtick-quoted `railway up`) is not at a boundary, so
# writing about these commands is never blocked.
if printf '%s' "$cmd" | grep -Eq '(^|[[:space:];|&(])railway[[:space:]]+(up|redeploy|down|delete)([[:space:]]|;|\||&|\)|$)'; then
  cat >&2 <<'MSG'
⛔ BLOCKED: `railway up` / `redeploy` / `down` / `delete` is forbidden in the aios-team-brain repo.

Deploy production ONLY by merging to `main` — Railway auto-deploys AIOS → aios-team-brain via the
GitHub integration (it is bound to that project and cannot hit another one).

Against this existing instance the CLI is READ-ONLY: `railway status`, `railway logs`,
`railway variables`, `railway deployment list`.

Standing up a BRAND-NEW brain is different and is allowed: `node scripts/setup.mjs` provisions
one with `railway init`/`add`/`variables`/`domain`/`run`, pinning the project it just created
and re-verifying the link before every write. It still never deploys — the first release comes
from pushing to `main`, like every release after it.

History: a `railway up` from a worktree mislinked to the **Kula** project deployed this repo's
code into Kula and took it down. That is exactly what this guard prevents.
MSG
  exit 2
fi

exit 0
