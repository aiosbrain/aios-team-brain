# Ops hardening — Sentry, CodeRabbit, BugBot

This note covers the observability + automated-review stack added in **W1.4**. The Sentry
*code* is wired in this repo; CodeRabbit and BugBot are GitHub/Cursor apps that a human org
owner must approve (they cannot be enabled from code).

---

## 1. Sentry (error monitoring) — W1.4.1

### What's wired

| File | Role |
|------|------|
| `instrumentation-client.ts` | Browser SDK init (`NEXT_PUBLIC_SENTRY_DSN`); exports `onRouterTransitionStart` for App Router nav tracing. |
| `sentry.server.config.ts` | Node.js runtime init (`SENTRY_DSN`). |
| `sentry.edge.config.ts` | Edge runtime init (`SENTRY_DSN`). |
| `instrumentation.ts` | `register()` imports the right config per `NEXT_RUNTIME`; exports `onRequestError = Sentry.captureRequestError` to forward server errors. |
| `app/global-error.tsx` | Root error boundary; calls `Sentry.captureException` and renders fallback UI. |
| `next.config.ts` | Wrapped with `withSentryConfig(...)` for build-time source-map upload. |

**Everything is env-driven and inert when unset.** With no DSN the SDK `init` is a no-op and
sends nothing; with no `SENTRY_AUTH_TOKEN` the build skips source-map upload. So local/CI
builds need no Sentry secrets. SDK version is `@sentry/nextjs` >= 10.13, required for
Turbopack source-map upload. There are no custom webpack plugins (Turbopack ignores them).

### Env vars (names only — set real values in your deploy env, never commit them)

See `.env.example` for the annotated list:

- `SENTRY_DSN` — server + edge runtimes.
- `NEXT_PUBLIC_SENTRY_DSN` — browser bundle (inlined into client JS; genuinely public).
- `SENTRY_TRACES_SAMPLE_RATE` / `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` — optional perf sampling (default 0).
- `SENTRY_ORG`, `SENTRY_PROJECT` — for source-map upload.
- `SENTRY_AUTH_TOKEN` — **SECRET**; build/CI env only. Generate at
  <https://sentry.io/settings/account/api/auth-tokens/> (scope `project:releases`).

Set the DSNs + (for source maps) `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN` in Railway
(runtime + build) and in CI for the production build.

### Smoke test — verify events + resolved source maps — W1.4.4

Do this against a **deployed build** (or a local `next build` + `next start`) with the DSNs
and source-map upload env set — source maps are uploaded by `next build`, so `next dev` will
not have resolved frames.

1. **Build with upload on.** With `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`,
   `SENTRY_PROJECT`, and `SENTRY_AUTH_TOKEN` set, run `npm run build`. Confirm the log shows
   Sentry uploading source maps (run with `CI=1` or `silent: false` to see it). Then
   `npm run start` (or deploy to Railway).

2. **Trigger a client (browser) error.** Add a temporary throw behind a button, or in the
   browser devtools console of any dashboard page run:
   ```js
   setTimeout(() => { throw new Error("sentry client smoke test"); });
   ```
   (A thrown error in a React render will surface `app/global-error.tsx`.) In Sentry → Issues,
   confirm a new event titled `sentry client smoke test` appears, and that the stack trace
   shows **original `.tsx` file + line numbers** (not minified `chunk-….js`). Resolved frames
   = source maps working.

3. **Trigger a server error.** Hit a route that throws on the server. Easiest: add a temporary
   route that throws, e.g. `app/api/_sentry-smoke/route.ts`:
   ```ts
   export function GET() { throw new Error("sentry server smoke test"); }
   ```
   Request it (`curl https://<host>/api/_sentry-smoke`). In Sentry, confirm a `sentry server
   smoke test` event with a resolved server stack trace. This exercises the `onRequestError`
   hook in `instrumentation.ts`.

4. **Clean up.** Remove the temporary throw / smoke route.

Expected outcome: two issues in Sentry (one client, one server), both with **un-minified**
stack traces pointing at the original source files.

---

## 2. CodeRabbit (automated PR review) — W1.4.2 — HUMAN STEP

CodeRabbit is a GitHub App; it is **free for public repos**. It cannot be enabled from code —
an org owner must install it.

1. Go to <https://github.com/apps/coderabbitai> and click **Install** (or sign in at
   <https://coderabbit.ai> with GitHub).
2. Install it on the **AIOS-alpha** org and select the public AIOS repos
   (`aios-team-brain`, `aios-workspace`, `aios-website`), or "All repositories".
3. CodeRabbit then auto-reviews new PRs. Optional: add a `.coderabbit.yaml` at repo root later
   to tune review behavior; the defaults are fine to start.

No env vars or secrets in this repo are required.

---

## 3. BugBot (Cursor) — W1.4.3 — HUMAN STEP

BugBot is Cursor's automated PR bug-finder. Enabling it requires approving the Cursor app for
the org (John is the **AIOS-alpha** org owner).

1. In Cursor, enable BugBot for the org (Cursor dashboard → BugBot / GitHub integration),
   which initiates a GitHub App authorization for **AIOS-alpha**.
2. Approve the Cursor app at **GitHub → AIOS-alpha org → Settings → Third-party Access**
   (GitHub Apps / OAuth app access). As org owner, John approves the pending Cursor request.
3. Grant it access to the public AIOS repos. BugBot then comments on PRs with potential bugs.

No env vars or secrets in this repo are required.

---

## 4. Railway deploy safety — links + project token — W1.4.5

**Incident:** the Railway CLI links each directory to a project in `~/.railway/config.json`
(keyed by absolute path). `railway up`/`redeploy` deploys the **current directory's code to that
linked project**. A Conductor worktree for *this* repo had drifted to the **Kula** project's link,
so a deploy from it shipped aios-team-brain into Kula and took Kula down.

### The rule (enforced)
Production deploys happen **only by merging to `main`** → Railway's GitHub integration auto-builds
**AIOS → `aios-team-brain`** (bound in the dashboard; cannot target another project). The Railway
CLI is **read-only** here. The destructive verbs are **blocked** by `.claude/settings.json`
(deny-list + the `scripts/railway-deploy-guard.sh` PreToolUse hook, which also catches the
`cd other && <deploy>` form). See CLAUDE.md §6.

### Runtime backstop (defense in depth)
The hook only fires inside the agent's shell. The **runtime** guard covers everything else (a human
`railway up`, or any path that lands this code on a foreign service): the schema loaders
(`pg-load-schema.mjs` = the `preDeployCommand`, `pg-load-vector.mjs`) call `assertServiceIdentity`
(`scripts/service-guard.mjs`) **before** opening a DB connection. If `RAILWAY_SERVICE_NAME` is set and
isn't an AIOS service (`aios` / `aios-*`; override `AIOS_RAILWAY_SERVICES`), the load aborts non-zero and
Railway halts the release — so aios can never inject its schema into another project's DB (2026-06-27).
This mirrors Kula's `src/lib/service-guard.ts`; both apps carrying it is what makes the protection
symmetric. Guarded by `test/guards/service-guard.test.ts`.

### After creating a new worktree
Conductor spawns worktrees that can inherit a wrong link. Audit + fix:

```bash
bash scripts/railway-link-check.sh   # flags any aios dir not linked to AIOS
# fix a flagged dir:
( cd <path> && railway link --project AIOS --environment production --service aios-team-brain )
```

### Strongest guard — a project-scoped token (recommended) — HUMAN STEP
A **project token** scopes the CLI to a single project + environment, so even a stray deploy from a
mislinked directory physically cannot reach another project (e.g. Kula).

1. Railway dashboard → **AIOS** project → **Settings → Tokens** → create a **Project token** for
   the **production** environment (name it e.g. `aios-cli`).
2. Put it in each aios worktree's environment (do **not** commit it):
   ```bash
   echo 'export RAILWAY_TOKEN=<the-project-token>' >> ~/.aios-railway.env   # or the worktree .env.local (gitignored)
   ```
   With `RAILWAY_TOKEN` set, the CLI ignores `~/.railway/config.json` and acts only on the AIOS
   project — link drift becomes harmless.
3. Verify: `railway status` shows **Project: AIOS** regardless of the directory's link.

> Tokens are secrets — never commit them; rotate from the dashboard if exposed.

---

# Day-2 Operations

Runbooks for the recurring operational tasks a v1 deploy actually needs: backing up the
database, rotating an API key, moving a brain-api contract version, and understanding the
current security model. Everything below is verified against what exists in this repo today
— where a capability doesn't exist, that's stated plainly rather than invented.

---

## 5. Postgres backup & restore

**There is no built-in backup command in this repo.** `npm run pg:schema` (`scripts/pg-load-schema.mjs`)
only *loads* `postgres/schema.sql` + `postgres/migrations/*` into a target database — it is a
forward-rollout step, not a backup/export tool. There is no `pg:dump`, `pg:backup`, or similar
script anywhere in `package.json` or `scripts/`. Use `pg_dump`/`pg_restore` directly against the
same connection the app itself uses.

### Connection pattern

Production Postgres is on Railway. The existing prod-access pattern (used by `scripts/admin.ts`,
see its header comment) is:

```bash
railway run -s Postgres bash -lc '<command using $DATABASE_PUBLIC_URL>'
```

`DATABASE_PUBLIC_URL` is Railway's externally-reachable connection string for the `Postgres`
service (as opposed to `DATABASE_URL`, which is the internal/private-network URL used by the
deployed app itself). Mirror that pattern for backup/restore — do not invent a different one.

### Backup

```bash
railway run -s Postgres bash -lc \
  'pg_dump "$DATABASE_PUBLIC_URL" -Fc -f "aios-team-brain-$(date +%Y%m%dT%H%M%S).dump"'
```

- `-Fc` (custom format) is required for `pg_restore` below; it's also compressed and supports
  selective/parallel restore, unlike plain-SQL `pg_dump` output.
- Run this from a directory you control — the dump lands in the shell `railway run` spawns
  locally, not on Railway's infrastructure. Copy it somewhere durable (encrypted object storage,
  not committed to git) immediately after.
- There is no scheduled/automatic backup wired up anywhere in this repo (no cron script, no
  Railway backup config checked in). Treat this as a **manual runbook** until that's built —
  if a recurring backup job is needed, it does not exist yet and would be new work, not a
  documented-but-hidden feature.

### Restore

Restoring into a **fresh** database (custom-format dump, matches the `-Fc` backup above):

```bash
railway run -s Postgres bash -lc \
  'pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_PUBLIC_URL" aios-team-brain-<timestamp>.dump'
```

- `--clean --if-exists` drops existing objects before recreating them, so this is destructive to
  whatever is currently in the target database — never point it at prod without a fresh backup
  of prod's *current* state taken first, and confirm with a human before restoring over a live
  service.
- `--no-owner` avoids failing on role/owner mismatches between the environment the dump was taken
  in and the one being restored into (Railway-managed Postgres roles can differ across projects).
- After a restore, run `npm run pg:schema` (`DATABASE_URL=$DATABASE_PUBLIC_URL npm run pg:schema`
  in a Railway shell, or the CLI's own `pg:schema` subcommand — see §6) once more to reapply any
  migration that postdates the dump. `postgres/schema.sql` and every file in `postgres/migrations/`
  are idempotent by design (`create table if not exists`, `alter table … add column if not
  exists` — see `postgres/migrations/README.md`), so re-running it after a restore is always safe.

---

## 6. API-key rotation — `scripts/admin.ts`

Key issuance and revocation are real, existing subcommands of the admin CLI
(`npm run admin -- <command>`, which runs `npx tsx --conditions react-server scripts/admin.ts`).
Read the CLI's own `USAGE` string (`scripts/admin.ts`) for the authoritative command list; the
two relevant commands today are:

```
issue-key <member-email> [--name <n>] [--team <slug>]
revoke-key <api-key-uuid> [--team <slug>]
```

Both require `DATABASE_URL` in the environment and default `--team` to `demo` if omitted (a team
UUID also works). Locally:

```bash
DATABASE_URL=postgres://… npx tsx --conditions react-server scripts/admin.ts issue-key jane@acme.com --name "jane-laptop" --team acme
```

Against prod, per the header comment in `scripts/admin.ts`:

```bash
railway run -s Postgres bash -lc \
  'DATABASE_URL=$DATABASE_PUBLIC_URL npx tsx --conditions react-server scripts/admin.ts issue-key jane@acme.com --name "jane-laptop" --team acme'
```

`issue-key` prints the raw key **once** (`✓ API key (shown once — store it now): aios_<key_id>_<secret>`)
— it is sha256-hashed at rest (per `README.md`'s security posture: "`key_hash` column-revoked from
clients") and cannot be recovered later. There is no "show existing key" command; a lost key can
only be revoked and reissued.

`revoke-key` takes the key's UUID (`id` column on `api_keys`, **not** the raw secret) —
find it via `list-keys`:

```bash
DATABASE_URL=postgres://… npx tsx --conditions react-server scripts/admin.ts list-keys --team acme
railway run -s Postgres bash -lc \
  'DATABASE_URL=$DATABASE_PUBLIC_URL npx tsx --conditions react-server scripts/admin.ts revoke-key <api-key-uuid> --team acme'
```

### Rotation walkthrough

1. **Issue the replacement first.** `issue-key <member-email> --name "<new-label>" --team <slug>`
   — copy the printed key immediately; it is never shown again.
2. **Propagate to consumers.** Update `AIOS_API_KEY` (the env var the `aios` CLI and any
   `aios push`/`aios query` automation read — see `README.md`'s local-dev example) everywhere the
   old key is configured: contributor `.env.local`/CI secrets, cron jobs, any scripted `aios push`.
   Confirm the new key works (`aios query "..."` or a manual `aios push`) before touching the old one.
3. **Find the old key's UUID.** `admin list-keys --team <slug>` (prints an `id`, `key_id`, `name`,
   `last_used_at`, `revoked_at` table) — locate the row for the key being retired by its `name`/`key_id`.
4. **Revoke the old key.** `admin revoke-key <api-key-uuid> --team <slug>`. Revocation is immediate
   and irreversible from the CLI (there's no `unrevoke-key`); if a mistake is made, issue a fresh key.
5. **Confirm.** Re-run `list-keys` and check the retired row now has a `revoked_at` timestamp, and
   that any automation that still used the old key started failing auth (expected) until updated in
   step 2.

There is no automatic/scheduled key-rotation job — this is a manual runbook, invoked whenever a
key is suspected compromised, a contributor offboards, or on whatever rotation cadence an org
chooses to adopt.

---

## 7. Upgrading across a brain-api contract bump

The brain-api wire contract is versioned in **`aios-workspace/docs/brain-api.md`** (currently
**v1.8**) — the single pinned contract both `aios-workspace` (the CLI/MCP client) and
`aios-team-brain` (this server) build against. Per that doc's own change policy: a **breaking**
change requires a **major version bump** (`/api/v2`); **additive** changes (new endpoints, new
item kinds, new optional fields) stay within the current major *only if both directions degrade
gracefully* — the server keeps old endpoints, and clients tolerate a `404` on anything they call
that an older brain doesn't yet serve.

### Where the version is pinned, in lockstep, on the brain side

| File | Role |
|------|------|
| `aios-workspace/docs/brain-api.md` | Source of truth for the wire contract; states the version in its first line (`**Version: 1.8**`) and carries a dated *Revisions* changelog for every additive change. |
| `docs/ARCHITECTURE.md` (this repo, §"Auth & access tiers") | Carries the canonical implemented-version claim in prose: `"This server implements brain-api v1.8"`. |
| `lib/api/version.ts` | `export const BRAIN_API_VERSION = "1.8"` — the single server-side declaration of which contract version this codebase targets. |
| `test/guards/contract-version.test.ts` | Fails the build if `BRAIN_API_VERSION` and the `ARCHITECTURE.md` prose claim drift apart — forces both to move together. |
| `aios-workspace/docs/contract/brain-contract.json` | Canonical conformance fixture (`version`, `tierAliases`, `sse.frames`, `provisioningTools`, `contentHash`). |
| `test/fixtures/contract/brain-contract.json` (this repo) | A vendored **copy** of the file above — must match byte-for-byte (`contentHash` pins the content) or `test/guards/contract-conformance.test.ts` fails. |

### The upgrade sequence

1. **Land the contract change in `aios-workspace/docs/brain-api.md` first** — bump the version
   line, add a dated bullet under *Revisions*, and (per the doc's own rule) update
   `aios-workspace/docs/contract/brain-contract.json` (`version` field, plus whichever of
   `tierAliases` / `sse.frames` / `provisioningTools` actually changed, then regenerate
   `contentHash` via that repo's `scripts/gen-contract-fixture.mjs`).
2. **Re-vendor the fixture into this repo**: copy the updated `brain-contract.json` into
   `test/fixtures/contract/brain-contract.json` verbatim so the `contentHash` matches.
3. **Bump `lib/api/version.ts`**'s `BRAIN_API_VERSION` to the new value.
4. **Update the prose claim in `docs/ARCHITECTURE.md`** ("...implements brain-api v1.8...") to
   the new version — `test/guards/contract-version.test.ts` matches that exact sentence.
5. **Implement the actual endpoint/field change** in this codebase (new route, new optional
   field, etc.), keeping old behavior intact if the bump is additive.
6. **Run the guards before opening the PR**: `npm test` (covers both
   `contract-version.test.ts` and `contract-conformance.test.ts`) and `npm run check:docs`
   (the drift guard for enumerable surfaces).
7. **Ship both repos in the same change window.** Because clients are required to tolerate a
   `404` on endpoints an older brain doesn't yet serve, an additive bump can deploy the brain
   first; but keep the version bump in `aios-workspace` and `aios-team-brain` as close together
   as possible so `docs/brain-api.md` never describes a contract neither side has actually shipped.

If any of steps 1–4 is skipped, the version pin drifts across the two repos silently until the
guard tests catch it (or, worse, until a client/server mismatch shows up in production) — that's
exactly the failure mode `contract-version.test.ts` and `contract-conformance.test.ts` exist to
prevent.

---

## 8. Security model

This repo's actual security posture, expanded from the summary already in `README.md`
("Security posture") and `CLAUDE.md` §5 ("Access control — tier isolation is an app-code
invariant"):

- **No Postgres Row-Level Security (RLS).** Postgres is the one and only backend, self-hosted per
  organization (each org runs its own instance against its own database — there is no shared
  multi-tenant DB, so cross-organization isolation is not a concern here). But **tier isolation**
  (an `external`-tier principal — e.g. a client/consultant collaborator — must never read
  `team`/`admin` content) is a real, live product feature that RLS does *not* enforce. It is
  enforced **entirely in application code**: the `lib/auth/visibility` choke-point plus re-applied
  tier filters in `/api/v1/items*` and `lib/query/retrieve.ts`. **A missing tier filter on a new
  read path has no database backstop** — this is a standing invariant every new dashboard surface
  must uphold for itself (guarded today by `test/guards/dashboard-tier-filter.test.ts` for the
  existing surfaces, proven by the data-mechanics test tier).
- **`admin`-tier content never reaches the database at all** — it's rejected at the API with a
  `422` before persistence, rather than being stored and relied on to be filtered out later.
- **Machine (sync) writes carry no DB-level tier backstop either.** The service-role write path is
  confined to one narrow, audited module (`lib/ingest`) plus route handlers — a single-writer
  discipline substituting for a DB constraint. `key_hash` is column-revoked from ordinary clients,
  and every write is captured in an append-only, trigger-backed audit log.
  - **Accepted risk, stated plainly:** this means correctness here depends on `lib/ingest` (and
    the API route handlers) staying the only code paths that write with elevated privilege — not
    on a database-level guarantee. If that invariant is ever violated by new code, there is
    currently nothing at the Postgres layer to catch it.
- **Known hardening work: [AIO-349](https://linear.app/je4light/issue/AIO-349/sec-visibility-choke-point-fails-open-on-unrecognized-tier-strings).**
  Found during v1 pre-release test hardening: every list-scoping function in
  `lib/auth/visibility.ts` (`visibleItems`, `visibleDecisions`, `visibleTasks`, `visibleByAccess`)
  currently gates with `if (tier !== "external") return query;` — an allow-list of exactly one
  restricted value, so a malformed or future tier string that isn't in the `ViewerTier` union
  falls through to the **unfiltered** branch instead of being denied. (`canSeeAccess` already
  fails closed — `tier === "team"` — and is the pattern the other four need to adopt.) Because
  there is no RLS backstop, this file is the *sole* enforcement point, which is exactly why the
  fail-open behavior matters. Not yet fixed as of this writing — treat the app-code enforcement
  above as the complete picture until AIO-349 lands, and do not assume RLS-equivalent protection
  exists anywhere in this schema.
