#!/usr/bin/env bash
#
# Audit the Railway CLI link map (~/.railway/config.json): flag any aios-team-brain directory
# linked to a project OTHER than "AIOS". Conductor spawns worktrees that can drift to the wrong
# link; a mislinked aios worktree is the exact condition that let a deploy hit the Kula project.
#
# Read-only. Exits non-zero if any aios directory is mislinked. Run it any time, e.g. after
# creating a new worktree:  bash scripts/railway-link-check.sh

set -euo pipefail

CONFIG="${HOME}/.railway/config.json"
if [[ ! -f "$CONFIG" ]]; then
  echo "No Railway link map at $CONFIG (CLI never linked) — nothing to check."
  exit 0
fi

python3 - "$CONFIG" <<'PY'
import json, sys

cfg = json.load(open(sys.argv[1]))
bad = []
total_aios = 0
for path, p in cfg.get("projects", {}).items():
    is_aios = "aios-team-brain" in path or path.rstrip("/").endswith("/aios")
    if not is_aios:
        continue
    total_aios += 1
    if p.get("name") != "AIOS":
        bad.append((path, p.get("name")))

if bad:
    print("❌ aios-team-brain directories linked to the WRONG Railway project:")
    for path, name in bad:
        print(f"   {path}  ->  {name}")
    print()
    print("Fix each:  ( cd <path> && railway link --project AIOS --environment production --service aios-team-brain )")
    sys.exit(1)

print(f"✅ all {total_aios} aios-team-brain worktree link(s) point at the AIOS project.")
PY
