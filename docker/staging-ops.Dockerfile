FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d -m 0755 /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 tini \
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
RUN set -eu; \
    test -x /usr/bin/tini || { echo "ops runner: /usr/bin/tini is missing or not executable" >&2; exit 1; }; \
    /usr/bin/tini --version >/dev/null || { echo "ops runner: /usr/bin/tini does not run" >&2; exit 1; }
USER node
# THE CHILD REAPER, on the runner that holds the fences.
#
# `runBoundedProcess` proves containment with `kill(-pgid, 0)`, and Linux answers success for an
# unreaped ZOMBIE group, which SIGKILL cannot remove. Under a non-reaping PID 1 (`node`), an orphaned
# grandchild of the only multi-level chain here — `reapplyTesters`: npx → tsx → node — leaves the
# group permanently "alive", so the importer spins in containment holding BOTH the coordinator and
# exclusive data-use locks, with staging stopped. Correct fail-closed behaviour, permanent outage.
#
# `-s` runs tini as a child subreaper, so adoption does not depend on it actually being PID 1 (on
# Railway it may sit beneath platform supervision). The compose harness supplies `init: true` as
# well, which is why CI cannot see this; Railway's scheduled services run
# `config/staging-ops/schedules.json`'s command, which must carry the same prefix.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "node"]
