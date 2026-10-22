FROM node:22-bookworm-slim
# Node 22.23.4 is the first 22.x with the eMudhra trust-store fix; a stale base layer fails the build.
RUN node -e 'const floors={22:"22.23.4",24:"24.22.1",26:"26.12.1"}; const v=process.versions.node; const f=floors[v.split(".")[0]]; const n=s=>s.split(".").map(Number); const [a,b]=[n(v),f?n(f):null]; const ok=f && (a[1]>b[1] || (a[1]===b[1] && a[2]>=b[2])); if (!ok) { console.error(f ? "node "+v+" predates the eMudhra trust-store fix (need >="+f+")" : "node "+v+" is not a supported line (need one of "+Object.values(floors).join(" / ")+"); add its first fixed release to this table and scripts/doctor.mjs"); process.exit(1); }'

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
