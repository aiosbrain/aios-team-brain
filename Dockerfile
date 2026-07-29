# AIOS Team Brain — container image for the one-command local stack (`docker compose up`).
#
# Scope, deliberately: this image exists so someone can evaluate the brain with Docker and
# nothing else — no Node on the host, no Postgres, no accounts, no API keys. It is NOT wired
# into the Railway deploy path, which still builds from the repo via the GitHub integration
# (railway.json's preDeployCommand runs the schema). Nothing here changes how production ships.
#
# Why the runtime stage keeps dev dependencies: first boot seeds the demo team by running
# `scripts/seed-demo.ts` and `scripts/admin.ts` through `tsx`, which is a devDependency. A
# slimmer `--omit=dev` runtime would need `output: "standalone"` in next.config.ts and a
# separate seeding image — worth doing for a production image, but that would change the
# build output the live deploy already depends on, so it is out of scope here.

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
FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# next start binds 0.0.0.0 by default in a container; be explicit so port-mapping is predictable.
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["npm", "start"]
