# AIOS Team Brain — the container image.
#
# Railway's GitHub integration auto-detects this root Dockerfile and BUILDS PRODUCTION with it.
# Railway overrides this image's ENTRYPOINT/CMD with railway.json's startCommand, so the entrypoint below is the local `docker compose` path only.
#
# It also serves the one-command local stack (`docker compose up`), which is what the ENTRYPOINT is
# for: evaluate the brain with Docker and nothing else — no Node on the host, no Postgres, no
# accounts, no API keys.
#
# Why the runtime stage keeps dev dependencies: first boot seeds the demo team by running
# `scripts/seed-demo.ts` and `scripts/admin.ts` through `tsx`, which is a devDependency. A
# slimmer `--omit=dev` runtime would need `output: "standalone"` in next.config.ts and a
# separate seeding image — that is DOCKERPROD-1, deliberately not this slice.

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Node TRUST-STORE FLOOR. Node verifies TLS against its OWN compiled-in root store, not Debian's, so
# the only way to drop a compromised CA is to run a Node that has dropped it. 22.23.4 is the first 22.x
# that rejects the eMudhra intermediates whose private keys were recovered from their public
# certificates (disclosed 2026-10-20; anyone can mint a "valid" cert for any host under them). Node 20
# is EOL and will never get that fix. The floating tag above is what keeps future fixes arriving; this
# line is what stops a cached base layer from quietly shipping an older 22.x. Same table as
# scripts/doctor.mjs NODE_TLS_FLOORS and install.sh (test/doctor.test.ts fails if they drift).
RUN node -e 'const floors={22:"22.23.4",24:"24.22.1",26:"26.12.1"}; const v=process.versions.node; const f=floors[v.split(".")[0]]; const n=s=>s.split(".").map(Number); const [a,b]=[n(v),f?n(f):null]; const ok=f && (a[1]>b[1] || (a[1]===b[1] && a[2]>=b[2])); if (!ok) { console.error(f ? "node "+v+" predates the eMudhra trust-store fix (need >="+f+")" : "node "+v+" is not a supported line (need one of "+Object.values(floors).join(" / ")+"); add its first fixed release to this table and scripts/node-tls-floor.mjs"); process.exit(1); }'

# ── deps: cached on the lockfile alone, so source edits don't reinstall ──────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ── build: `next build` needs no database (CI builds it with no DATABASE_URL),
#    and the Sentry wrapper is inert without SENTRY_AUTH_TOKEN, so this stage
#    requires no secrets and no network beyond npm.
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── runtime ─────────────────────────────────────────────────────────────────
# This stage reads NOTHING from the build context. The boot chain is already here — the build
# stage's `COPY . .` put `docker/` under /app and the copy below brings it across — so a second
# trip to the context would copy a file the image already has, from the one source that can fail
# mid-build. That instruction failed two production deploys (DOCKERPROD-2).
FROM base AS runner
ENV NODE_ENV=production

# A CHILD REAPER, installed before the terminal boot-chain assertion below because it is part of
# that chain. The startup fence supervises a PAYLOAD CHAIN (`sh`/`npm` → `next`). When a wrapper and
# its descendant die together, the grandchild is reparented to PID 1; if PID 1 does not reap, it
# stays a ZOMBIE, `kill(-pgid, 0)` keeps succeeding for that group, and the fence's strict
# group-gone verification never completes — so it holds its healthy shared lock and refuses the
# stop forever. Node as PID 1 does not reap processes it did not spawn.
#
# Both effective start paths must have this as an ancestor of the fence: this image's ENTRYPOINT
# (local `docker compose`) and `scripts/railway-start.sh` (Railway overrides ENTRYPOINT/CMD with
# railway.json's startCommand, so an entrypoint-only init would not cover the hosted path at all).
# `-s` (subreaper) so orphan adoption does not depend on tini actually being PID 1 — on Railway it
# may sit beneath platform supervision, and repository files establish nothing about that parent's
# reaping behaviour.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app ./

# next start binds 0.0.0.0 by default in a container; be explicit so port-mapping is predictable.
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000

# TERMINAL boot-chain assertion — nothing below this line may touch the filesystem.
#
# Deleting the context COPY above would otherwise convert a BUILD failure into a RUNTIME one: a
# build stage missing these files would produce a green image and a container that dies at boot.
# This puts the failure back at build time. `-f`/`-s` and not `-r` alone, because the build runs as
# root — where `-r` passes on a directory and on a zero-byte file, both of which still boot dead.
# NOT `-x`: the ENTRYPOINT below invokes through `sh`, which reads the file rather than executing
# it, and requiring the mode bit would re-couple what that form deliberately decouples.
#
# ⚠️ EACH TEST EXITS EXPLICITLY, and that is not style. The first version of this line was
# `test -f "$f" && test -s "$f" && test -r "$f"` under `set -eu`, which DOES NOT FAIL: POSIX
# ignores errexit for a command in an AND-OR list, so a missing file fell straight through and the
# build went green. Measured — a build with bootstrap.mjs absent printed "BUILD PASSED WITH
# bootstrap.mjs MISSING". An assertion that cannot fail is worse than none, because it reads as
# coverage. `|| { …; exit 1; }` depends on no shell option at all, and names what is missing.
RUN set -eu; \
    for f in /app/docker/entrypoint.sh /app/docker/bootstrap.mjs /app/scripts/staging-ops/startup-fence.mjs /app/scripts/railway-start.sh; do \
      test -f "$f" || { echo "boot chain: $f is missing or not a regular file" >&2; exit 1; }; \
      test -s "$f" || { echo "boot chain: $f is empty" >&2; exit 1; }; \
      test -r "$f" || { echo "boot chain: $f is not readable" >&2; exit 1; }; \
    done; \
    /bin/sh -n /app/docker/entrypoint.sh; \
    /bin/sh -n /app/scripts/railway-start.sh; \
    test -x /usr/bin/tini || { echo "boot chain: /usr/bin/tini is missing or not executable" >&2; exit 1; }; \
    /usr/bin/tini --version >/dev/null || { echo "boot chain: /usr/bin/tini does not run" >&2; exit 1; }

# Invoked through `sh` rather than as a bare path so INVOKING the entrypoint depends on nothing
# outside this file — not the executable bit, not `/usr/bin/env`, not PATH. (The script's own line 5
# still resolves `node` through PATH; that is unchanged and not what this form is about.) Same idiom
# as railway.json's `sh scripts/railway-start.sh`.
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
# Load-bearing, not decoration: entrypoint.sh ends in `exec "$@"`, and POSIX `exec` with zero
# arguments is a no-op — an empty CMD makes the script fall off the end and exit 0, which is a
# green build and a container that vanishes at boot with no error anywhere.
CMD ["npm", "start"]
