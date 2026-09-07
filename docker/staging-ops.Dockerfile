FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d -m 0755 /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY --chown=node:node . .
# `/app` ITSELF, not just its contents. `WORKDIR` creates the directory as root before the `USER`
# switch, and `COPY --chown` only sets ownership on what it copies — so the directory stayed
# root-owned and unwritable, and `next dev` died with
# `EACCES: permission denied, open '/app/next-env.d.ts'` (runtime 5, service-maintenance.log:17):
# it CREATES that file on startup, which needs write permission on the directory, not on a file.
# Scoped deliberately: this directory and `.next` only — no recursive chown, no chmod 777, no root
# runtime, and no change to the production Dockerfile, which does not run `next dev`.
RUN install -d -o node -g node /app/.next && chown node:node /app
USER node
ENTRYPOINT ["node"]
