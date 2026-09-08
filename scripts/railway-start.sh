#!/usr/bin/env sh
set -eu

# Railway's custom start command replaces the Docker ENTRYPOINT, so keep the same idempotent
# bootstrap for both existing deployments and template-created installs.
#
# ⚠️ THE INIT IS LOAD-BEARING, and it must be HERE rather than only in the image's ENTRYPOINT.
# Railway overrides ENTRYPOINT/CMD with railway.json's startCommand (`sh scripts/railway-start.sh`),
# so an init added only to the Dockerfile ENTRYPOINT would not appear on this path at all — this is
# the effective hosted start command, and it is the one that must have a reaper as an ancestor of
# the fence and every payload it spawns.
#
# Why: the fence supervises a payload CHAIN (`sh` → `npm start` → `next`). A wrapper and descendant
# that die together leave the grandchild reparented to the container's PID 1; without a reaper it
# stays a ZOMBIE, `kill(-pgid, 0)` still succeeds for that group, and the fence's strict group-gone
# check therefore reads a completed stop as an eternally live workload — holding its healthy shared
# lock and refusing every refresh. `-s` runs tini as a child SUBREAPER so orphan adoption works even
# when tini is not PID 1 (on Railway it may sit beneath platform supervision, whose reaping
# behaviour nothing in this repository establishes).
#
# tini forwards TERM/INT to its direct child — the fence — and exits with the fence's status, so
# signal handling and exit propagation are unchanged. Deliberately NOT `-g`: group-wide forwarding
# would signal processes the fence owns and stops itself, through its own bounded lifecycle.
exec /usr/bin/tini -s -- node scripts/staging-ops/startup-fence.mjs -- sh -c 'node docker/bootstrap.mjs && exec npm start'
