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

FROM node:20-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

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
    for f in /app/docker/entrypoint.sh /app/docker/bootstrap.mjs; do \
      test -f "$f" || { echo "boot chain: $f is missing or not a regular file" >&2; exit 1; }; \
      test -s "$f" || { echo "boot chain: $f is empty" >&2; exit 1; }; \
      test -r "$f" || { echo "boot chain: $f is not readable" >&2; exit 1; }; \
    done; \
    /bin/sh -n /app/docker/entrypoint.sh

# Invoked through `sh` rather than as a bare path so the boot depends on nothing outside this file
# — not the executable bit, not `/usr/bin/env`, not PATH. Same idiom as railway.json's
# `sh scripts/railway-start.sh`.
ENTRYPOINT ["/bin/sh", "/app/docker/entrypoint.sh"]
# Load-bearing, not decoration: entrypoint.sh ends in `exec "$@"`, and POSIX `exec` with zero
# arguments is a no-op — an empty CMD makes the script fall off the end and exit 0, which is a
# green build and a container that vanishes at boot with no error anywhere.
CMD ["npm", "start"]
