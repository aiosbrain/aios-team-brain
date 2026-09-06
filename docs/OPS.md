# Ops hardening — Sentry, CodeRabbit, BugBot

This note covers the observability + automated-review stack added in **W1.4**. Sentry is wired in
code; CodeRabbit is configured in-repository but installed as a GitHub App, and the per-repository
Cursor Bugbot setting is managed manually in Cursor.

---

## 1. Sentry (error monitoring) — W1.4.1

### What's wired

| File                        | Role                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `instrumentation-client.ts` | Browser SDK init (`NEXT_PUBLIC_SENTRY_DSN`); exports `onRouterTransitionStart` for App Router nav tracing.                                |
| `sentry.server.config.ts`   | Node.js runtime init (`SENTRY_DSN`).                                                                                                      |
| `sentry.edge.config.ts`     | Edge runtime init (`SENTRY_DSN`).                                                                                                         |
| `instrumentation.ts`        | `register()` imports the right config per `NEXT_RUNTIME`; exports `onRequestError = Sentry.captureRequestError` to forward server errors. |
| `app/global-error.tsx`      | Root error boundary; calls `Sentry.captureException` and renders fallback UI.                                                             |
| `next.config.ts`            | Wrapped with `withSentryConfig(...)` for build-time source-map upload.                                                                    |

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
   setTimeout(() => {
     throw new Error("sentry client smoke test");
   });
   ```

   (A thrown error in a React render will surface `app/global-error.tsx`.) In Sentry → Issues,
   confirm a new event titled `sentry client smoke test` appears, and that the stack trace
   shows **original `.tsx` file + line numbers** (not minified `chunk-….js`). Resolved frames
   = source maps working.

3. **Trigger a server error.** Hit a route that throws on the server. Easiest: add a temporary
   route that throws, e.g. `app/api/_sentry-smoke/route.ts`:

   ```ts
   export function GET() {
     throw new Error("sentry server smoke test");
   }
   ```

   Request it (`curl https://<host>/api/_sentry-smoke`). In Sentry, confirm a `sentry server
smoke test` event with a resolved server stack trace. This exercises the `onRequestError`
   hook in `instrumentation.ts`.

4. **Clean up.** Remove the temporary throw / smoke route.

Expected outcome: two issues in Sentry (one client, one server), both with **un-minified**
stack traces pointing at the original source files.

---

## 2. CodeRabbit (label-gated PR review) — W1.4.2

CodeRabbit remains installed on the `aiosbrain` repositories. `.coderabbit.yaml` keeps
`auto_review.enabled: true` but restricts it with `labels: [ready-for-review]` — the `labels`
setting **filters automatic reviews** (it is not an independent trigger, which is why `enabled`
must stay `true`). Result: CodeRabbit auto-reviews only PRs carrying the label.

1. Ensure the repository label exists:

   ```bash
   gh label create ready-for-review --repo aiosbrain/aios-team-brain \
     --description "Trigger CodeRabbit review for the current PR head" --color 0E8A16
   ```

2. Apply it when no local reviewer (Local Bugbot / Fable) was available for the PR, or whenever an
   extra automated pass is wanted. This label is also the sanctioned way to satisfy the required
   review gate (`pr-review-gate.yml`) when no local reviewer could run — see CLAUDE.md §"Review gate".
3. After any later push, comment `@coderabbitai review`; the label does not trigger incremental
   reviews while `auto_incremental_review: false`.
4. Prefer substantive comments/reviews created at or after the latest PR commit as evidence. A
   green check run without review text is weak evidence.

No repository secret is required.

---

## 3. Cursor Bugbot — W1.4.3 — HUMAN STEP

Remote Cursor Bugbot should be disabled for this repository — John already runs **Local Bugbot**
in Cursor as his pre-push reviewer (Chetan uses Fable), so the remote bot only duplicates that
signal. In the Cursor dashboard, open the GitHub/Bugbot installations list and disable Bugbot
for `aiosbrain/aios-team-brain` specifically.

Do not use an undocumented API and do not uninstall the all-repository Cursor GitHub App: other
Cursor integration access remains in use. After changing the setting, verify on a non-draft PR that
no `cursor[bot]` review activity appears.

---

## 4. Railway deploy safety — links + project token — W1.4.5

**Incident:** the Railway CLI links each directory to a project in `~/.railway/config.json`
(keyed by absolute path). `railway up`/`redeploy` deploys the **current directory's code to that
linked project**. On 2026-06-27 a Conductor worktree for _this_ repo had drifted to an unrelated
project's link, so a deploy from it shipped aios-team-brain into that project and took it down.

### The rule (enforced)

Production deploys happen **only by merging to `main`** → Railway's GitHub integration auto-builds
**AIOS → `aios-team-brain`** (bound in the dashboard; cannot target another project). The Railway
CLI is **read-only** here. The destructive verbs are **blocked** by `.claude/settings.json`
(deny-list + the `scripts/railway-deploy-guard.sh` PreToolUse hook, which also catches the
`cd other && <deploy>` form). See CLAUDE.md §6.

### Runtime backstop (defense in depth)

The hook only fires inside the agent's shell. The **runtime** guard covers the rest: the schema
loaders (`pg-load-schema.mjs` = the `preDeployCommand`, `pg-load-vector.mjs`) call
`assertServiceIdentity` (`scripts/service-guard.mjs`) **before** opening a DB connection. If the
deploy is an AIOS one and `RAILWAY_SERVICE_NAME` isn't an AIOS service (`aios` / `aios-*`; override
`AIOS_RAILWAY_SERVICES`), the load aborts non-zero and Railway halts the release.

**"An AIOS one" is the load-bearing part, and it is deliberately narrow.** This repo is public and
self-hosted, and `pg-load-schema.mjs` is the `preDeployCommand` — so an unconditional check turns
"you named your Railway service after your company" into an unrecoverable failed release for a
stranger. Enforcement therefore requires a marker: `RAILWAY_PROJECT_ID` matching AIOS's own project
(platform-injected, so it cannot be pruned away and quietly disable production protection), or an
explicit `AIOS_RAILWAY_SERVICES`, which any self-hoster can set to opt into the same guard for
their own service names. Known limit, by construction: a deploy pushed into a **different** Railway
project inherits that project's environment, so the marker is not visible there and the runtime
guard will not fire — that case is owned by the layers above (deny-list, hook, link check, project
token) and by the receiving app carrying this same guard for itself. Guarded by
`test/guards/service-guard.test.ts`.

### After creating a new worktree

Conductor spawns worktrees that can inherit a wrong link. Audit + fix:

```bash
bash scripts/railway-link-check.sh   # flags any aios dir not linked to AIOS
# fix a flagged dir:
( cd <path> && railway link --project AIOS --environment production --service aios-team-brain )
```

### Strongest guard — a project-scoped token (recommended) — HUMAN STEP

A **project token** scopes the CLI to a single project + environment, so even a stray deploy from a
mislinked directory physically cannot reach another project — which is exactly the gap the runtime
guard cannot close on its own.

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
only _loads_ `postgres/schema.sql` + `postgres/migrations/*` into a target database — it is a
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
  of prod's _current_ state taken first, and confirm with a human before restoring over a live
  service.
- `--no-owner` avoids failing on role/owner mismatches between the environment the dump was taken
  in and the one being restored into (Railway-managed Postgres roles can differ across projects).
- After a restore, run `npm run pg:schema` once more to reapply any migration that postdates the
  dump — **from a plain shell with `DATABASE_URL` set to the target's public URL, NOT through
  `railway run`.** This bullet used to say "in a Railway shell" and that is wrong: `railway run -s
  Postgres` injects `RAILWAY_SERVICE_NAME=Postgres` plus the project marker, and
  `assertServiceIdentity` (`scripts/service-guard.mjs`) then **refuses before opening the database**
  (§4, Runtime backstop). Off-Railway the same guard no-ops, so the plain shell is the working path.
  Corrected while building the staging refresh (§11), which hit it. `postgres/schema.sql` and every file in `postgres/migrations/`
  are idempotent by design (`create table if not exists`, `alter table … add column if not
exists` — see `postgres/migrations/README.md`), so re-running it after a restore is always safe.

### Codebase finding-ledger rollback

Migration `20260804120000_codebase_finding_ledger.sql` adds only derived, redacted lifecycle
state. The authoritative scan snapshots remain in `code_metrics.codebase_health`. If the ledger
must be removed before a dependent Phase 1 release, first take and verify a backup, stop scan
ingest, deploy code that no longer calls `reconcile_codebase_findings`, drop that function, then
drop `codebase_finding_events` before `codebase_findings`. Dropping either table destroys lifecycle
history and is therefore a human-approved rollback, never an automatic migration step. Re-running
`npm run pg:schema` recreates the empty tables and function; the current migration does not
backfill old snapshots or guess historical transitions.

### Explainable-debt decision rollback

Migration `20260804160000_explainable_debt_decisions.sql` is additive. The preferred application
rollback is to deploy code that does not call `decide_codebase_finding` and retain the decision
columns/events: old application builds ignore them, and operator history remains recoverable.
Do not set `codebase_finding_events.metrics_id` back to `NOT NULL` while operator events exist;
decision events intentionally use a null metrics id so repeated human decisions cannot collide
with scan-replay idempotency.

A physical rollback is destructive to audit history and requires a verified backup plus human
approval. In order: disable the decision action, drop `decide_codebase_finding`, export the
operator events (`event_type in ('accepted','risk_accepted','false_positive')`), delete those null-
metrics events only after the export is verified, restore the metrics-id constraint, then drop the
decision-expiry index, decision metadata constraint, and five decision columns. The scanner
snapshot and original finding ledger remain authoritative throughout; never drop either ledger
table for a Phase 1 UI rollback.

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

The brain-api wire contract is versioned in **`aios-workspace/docs/brain-api.md`** (this server
declares **v1.23** — `lib/api/version.ts`; this paragraph said v1.21 until 2026-08-25, which is the
drift the table below exists to prevent and did not) — the single pinned contract both `aios-workspace` (the CLI/MCP client) and
`aios-team-brain` (this server) build against. Per that doc's own change policy: a **breaking**
change requires a **major version bump** (`/api/v2`); **additive** changes (new endpoints, new
item kinds, new optional fields) stay within the current major _only if both directions degrade
gracefully_ — the server keeps old endpoints, and clients tolerate a `404` on anything they call
that an older brain doesn't yet serve.

### Where the version is pinned, in lockstep, on the brain side

| File                                                       | Role                                                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `aios-workspace/docs/brain-api.md`                         | Source of truth for the wire contract; states the version in its first line (**the number lives there, not here** — copying it into this table is what let the paragraph above drift) and carries a dated _Revisions_ changelog for every additive change. |
| `docs/ARCHITECTURE.md` (this repo, §"Auth & access tiers") | Carries the canonical implemented-version claim in prose, pinned against the code by `test/guards/contract-version.test.ts`.                                                                  |
| `lib/api/version.ts`                                       | `export const BRAIN_API_VERSION` — **the** single server-side declaration of which contract version this codebase targets. Read it there; every copy of the number in prose has drifted at least once.                                        |
| `test/guards/contract-version.test.ts`                     | Fails the build if `BRAIN_API_VERSION` and the `ARCHITECTURE.md` prose claim drift apart — forces both to move together.                                              |
| `aios-workspace/docs/contract/brain-contract.json`         | Canonical conformance fixture (`version`, `tierAliases`, `sse.frames`, `provisioningTools`, `contentHash`).                                                           |
| `test/fixtures/contract/brain-contract.json` (this repo)   | A vendored **copy** of the file above — must match byte-for-byte (`contentHash` pins the content) or `test/guards/contract-conformance.test.ts` fails.                |

### The upgrade sequence

1. **Land the contract change in `aios-workspace/docs/brain-api.md` first** — bump the version
   line, add a dated bullet under _Revisions_, and (per the doc's own rule) update
   `aios-workspace/docs/contract/brain-contract.json` (`version` field, plus whichever of
   `tierAliases` / `sse.frames` / `provisioningTools` actually changed, then regenerate
   `contentHash` via that repo's `scripts/gen-contract-fixture.mjs`).
2. **Re-vendor the fixture into this repo**: copy the updated `brain-contract.json` into
   `test/fixtures/contract/brain-contract.json` verbatim so the `contentHash` matches.
3. **Bump `lib/api/version.ts`**'s `BRAIN_API_VERSION` to the new value.
4. **Update the prose claim in `docs/ARCHITECTURE.md`** — the one sentence of the form
   `This server **implements brain-api v<OLD>**` — to the new version;
   `test/guards/contract-version.test.ts` matches that exact sentence.
5. **Implement the actual endpoint/field change** in this codebase (new route, new optional
   field, etc.), keeping old behavior intact if the bump is additive.
6. **Ask what the change costs the SCHEMA, and write the migration if it costs anything.** If the
   contract change touches a persisted vocabulary or shape — an enum value, a column, a
   constraint — editing `postgres/schema.sql` alone is **not enough**. That file expresses its
   objects with `create ... if not exists` (and guarded `do $$ ... $$` blocks), so it is a silent
   no-op against an already-deployed database; the catch-up delta belongs under
   `postgres/migrations/`. Read `postgres/migrations/README.md` for the rules that directory
   enforces (idempotence, replay order, the CHECK-widening trap) rather than guessing.
   - **The worked example is v1.21 itself (AIO-950).** `tasks.status` is the Postgres ENUM
     `task_status`, created in `schema.sql` inside a
     `do $$ ... exception when duplicate_object then null $$` guard. On every already-deployed
     brain that type already exists, so adding a value to the `create type` line does **nothing**,
     `npm run pg:schema` still runs green, and the failure surfaces only at the first write of the
     new value, as `invalid input value for enum task_status`. The fix was **both** files, as the
     README's mirroring rule requires: the widened `create type` in `schema.sql` for a from-zero
     load, plus the catch-up delta
     `postgres/migrations/20260819180000_task_status_in_review.sql` for every DB that already
     exists.
   - **Enum ordering is part of the change.** Where the new value has a natural position, pin it
     (`alter type ... add value ... before 'blocked'`). `order by status` sorts on the enum's own
     sort order, so appending at the end silently re-orders every status-sorted surface.
   - **Migrations self-apply — do not plan a manual prod step.** `scripts/pg-load-schema.mjs` is
     Railway's `preDeployCommand` (§4), so a deploy applies pending migrations *before* the new
     app version goes live, and a failure there aborts the release instead of shipping code ahead
     of its schema. **Never** run `npm run pg:schema` by hand as a rollout step — locally the
     loader targets whatever `DATABASE_URL` your shell holds, which in a worktree is the dev/test
     database, not prod.
7. **Run the guards before opening the PR**: `npm test` (covers both
   `contract-version.test.ts` and `contract-conformance.test.ts`) and `npm run check:docs`
   (the drift guard for enumerable surfaces).
8. **Ship both repos in the same change window.** Because clients are required to tolerate a
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
  `team`/`admin` content) is a real, live product feature that RLS does _not_ enforce. It is
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
  there is no RLS backstop, this file is the _sole_ enforcement point, which is exactly why the
  fail-open behavior matters. Not yet fixed as of this writing — treat the app-code enforcement
  above as the complete picture until AIO-349 lands, and do not assume RLS-equivalent protection
  exists anywhere in this schema.

---

## 9. Access enforcement — arming per-project visibility for a team

> ⚠️ **THE ARMING STEP IS RETIRED (PRET-6).** There is no longer a mode to flip: `permissive` was
> deleted, `teams.access_enforcement` was dropped from the schema, and `set-access-enforcement` was
> removed from the admin CLI. **Enforcing is the only behaviour** — membership decides what a member
> reads, always. What survives below is the description of *what enforcement covers*, which is still
> accurate and still worth reading; the commands that armed it no longer exist.
>
> Upgrading an installation that predates the retirement is an ordered, one-way path:
> [`RELEASING.md`](RELEASING.md) §3.4 and `RELEASE-NOTES-pret6.md`.

**What this used to mean, and why the section exists:** a team was `permissive` until someone armed
it, and `permissive` meant one flat pool — every `team`-tier member read every other member's pushed
content and the whole timeline. That default is what PRET-6 removed.

### The command — REMOVED

The arming command is gone. It is not reproduced here even as an example: a copyable command for a
verb the CLI no longer has is found during an incident, which is the worst moment to discover it.

- The team is a **positional argument**, not `--team`. Every other command in this CLI defaults to
  `--team demo`; a silent default on the flag that decides what an entire team can see is exactly
  the accident this command must not enable, so it has to be named. A team UUID also works.
- The mode must be **exactly** `permissive` or `enforcing`. `Enforcing`, `enforce`, `on` and
  friends are rejected before the database is touched — `teamEnforcesAccess` reads every other
  string as OFF, so an accepted typo would look armed and be inert.
- `--dry-run` reports readiness and writes nothing — including no bootstrap and no backfill. It
  answers "is this safe right now", not "could it be made safe".
- The mode printed at the end is the value **read back off the row**, not the one you asked for.
- Every flip writes an `audit_log` row: `action='access.enforcement_changed'`, `meta={from,to}`.

### Why `enforcing` is not just an UPDATE

Under enforcing a read serves only items with a current include-membership into a project the
reader's groups are granted. A brain that has never run the §11 bootstrap and backfill has **no
memberships at all**, so the naive flip (the raw SQL that was the only option before this command
existed) hides 100% of the content from 100% of the people — including each person's own work.
That is asserted, not assumed: see the `NAIVE flip … blinds everyone` case in
`test/datamechanics/access-enforcement-flip.datamechanics.test.ts`.

So `enforcing` does the preparation itself, in order:

1. `ensureAccessBootstrap` — built-in groups (`everyone` / `external`), their membership synced
   from the members table, the `general` / `external-shared` system projects, and the three grants.
2. `drainTeamContext` — the §11 backfill, drained to completion, so every existing item has an
   item-grain unit and an include-membership.
3. `assessEnforcementReadiness` — then, and only then, it verifies and **refuses** on any blocker:
   - an item with no current membership (it would become invisible to everyone), or
   - an **active human** whose oracle-visible project set doesn't reach their tier's system
     project (they would see nothing).
   A refusal leaves the flag exactly as it was.

Steps 1 and 2 are idempotent and are what the 30-minute scheduler tick does anyway; running them
here just means you don't have to wait for a tick or run them by hand.

**Warnings that are not blockers.** Two kinds, and both are literal rather than decorative:

- An active **agent** member in no granted group. Agents are deliberately never auto-admitted to
  the built-in groups, so that agent's `GET /api/v1/items` returns zero rows under enforcing until
  an admin places it in a group that is granted something.
- An active **connector** (the auto-provisioned per-source ingest actor). A connector is not a
  principal, so the oracle resolves it to nothing — but API-key auth only rejects a non-*active*
  member, so a connector key that reads today reads nothing after the flip. Connectors normally
  only push, which is why this is a warning and not a refusal; check whether any of yours also
  pulls. (On the AIOS production team as of 2026-08-17, 4 of 9 active members are connectors.)

If an integration goes quiet after a flip, these two are the first things to check.

**One window the preflight cannot close.** The backfill drain is bounded to the corpus that
existed when it started, and the coverage scan runs after it. An item ingested between that scan
and the flag write — or by a non-push path whose on-ingest partition hook failed — has no
membership yet and is invisible until the next 30-minute scheduler tick reconverges it. That
direction is fail-CLOSED (content briefly hidden, never leaked) and self-heals, but if you are
arming enforcement during an active sync, wait a tick and re-run `--dry-run` before you trust the
verdict.

### Rolling back — **there is no longer a way back**

**PRET-6 deleted the permissive mode.** `set-access-enforcement` is gone from the admin CLI and
`teams.access_enforcement` is dropped from the schema, so the command this section used to publish —
`… scripts/admin.ts set-access-enforcement <team-slug> permissive` — no longer exists. It is recorded
here rather than silently removed, because a stale rollback instruction is worse than an absent one:
someone reaching for it during an incident would burn the incident discovering it.

Membership is now the only thing that decides what a member reads. The undo for an over-broad grant is
a membership or grant change (`npm run admin -- revoke-project …`), not a mode flip. If you are
upgrading a pre-flip installation, the ordered path — and the fact that it is one-way — is in
[`RELEASING.md`](RELEASING.md) §3.4 and `RELEASE-NOTES-pret6.md`.

### What `enforcing` actually covers — and what it does not

**Covered** (`lib/access/enforce.ts` is the primitive; scope is Phase B through slice 5):

- `GET /api/v1/items`, for member keys **and** agent keys;
- the retrieval path (`lib/query/retrieve.ts`) behind both query routes, for member keys;
- delegated `aiosd_*` tokens — these are **always** attenuated, on a permissive team too;
- the work timeline (`GET /api/v1/timeline`, the Pulse "Working on" card and its disclosure), via
  a per-visibility cache variant;
- narrative arcs (`POST /api/brain/arcs` and `…/recompute`), all-or-nothing per arc.

**Not covered.** The remaining dashboard surfaces are not enforced yet — they still show
everything the viewer's *tier* allows. Do not describe this flag to a customer as "members can now
only see their own projects" across the product; it is true of the surfaces above and of nothing
else. Residual, stated in `lib/access/enforce.ts` and worth repeating: an arc's synthesized prose
is written from the full tier fact pool, so a kept arc's summary can still mention restricted work
that isn't among its cited evidence. Per-project synthesis (Phase C) is the structural fix.

**What enforcing does not buy.** On a stock team the §11 topology is `general ↔ everyone`, so an
enforcing read is **byte-identical** to a permissive one: every team-tier member still sees every
other member's content. Enforcement is the gate; **curation** is what closes it — an initiative
project granted to a specific group, with the item's membership moved into that project. The flag
only makes curation bite. (Pinned by the `enforcing ALONE does not separate teammates` case in the
data-mechanics test above.)

`admin`/`private`-tier content is orthogonal and unaffected: it is refused at the API with a `422`
before it is ever stored, in both modes.

---

## 10. Removing content — `purge-items`

```
npx tsx --conditions react-server scripts/admin.ts \
  purge-items --team <id|slug> --ids <uuid,uuid,…> --reason "<text>" [--confirm]
```

**Dry run by default.** With no `--confirm` it resolves the ids, prints each item's path, kind,
tier and episode count, prints how many of those episodes are actually projected into
Graphiti/Neo4j, and deletes nothing. `--confirm` is what removes content, and removal is
irreversible.

Use this instead of SQL. `delete from items` looks equivalent and is not: `graph_episodes` has **no
foreign key** to `items`, so a raw delete orphans the ledger rows and leaves the corresponding
nodes live in Neo4j with nothing pointing at them. The command routes through `purgeItemIds`, which
records the paths into an `items.purged` audit row **before** deleting (afterwards nothing on the
box can answer "what went?"), retires the graph episodes **first**, lets the FK cascade take
`item_versions` / `item_chunks` / `extracted_facts` / `stakeholder_mentions` / `task_evidence` /
`meeting_notes`, and busts `work_timeline_cache` + `arc_cache` so neither keeps quoting content the
brain no longer has. `tasks.source_item_id` / `decisions.source_item_id` are set to null on
purpose — those are independently authored records that merely cite the item.

Guardrails, and why each exists:

- **Explicit ids only.** The path-prefix purge (`purgeItemsByPathPrefix`) is intentionally
  unreachable from the CLI: it is team-wide, and the workspace path roots (`0-context/`, `2-work/`,
  `3-log/`) are shared by every project in a team, so one mistyped prefix would delete unrelated
  real content. A guard test fails the build if it is ever imported here.
- **`--team` is required** — no `demo` fallback on a destructive command.
- **Every id must be a well-formed uuid**, checked before the database is touched.
- **Every id must be an item on that team, or the command refuses.** `purgeItemIds` is
  team-scoped, so a foreign id would silently no-op while still being counted — you would read
  "14 purged" for 13 deletions.
- **`--reason` is required**; it is written into the audit row.

The graph cleanup finishes asynchronously: the ledger row survives as a
`pending_delete_group_id` tombstone so `reconcileProjectedEpisodes` can retry a Graphiti blip, and
drops only once the group is verified empty. When Graphiti isn't configured the row is dropped
outright — nothing was ever pushed, so there is nothing to retry.

## 11. Staging refresh — prod-shaped data in staging (`scripts/staging-refresh.sh`)

Copies **production's** Postgres into **staging's own** Postgres so a branch can be looked at against
real data. Design + the reasoning behind every refusal: `docs/design/staging-prod-shaped-data.md`
(STAGING-1). Staging URL: `https://aios-team-brain-staging.up.railway.app`.

**The dangerous direction is the reverse one.** `pg_restore --clean` drops what it is about to
recreate, so a target pointed at production destroys production. Read the refusals below before
reaching for a manual `pg_dump`.

### One-time: declare the target a staging database

The script refuses any target that does not carry a `staging_marker` table. That table exists **only**
in staging — it is deliberately absent from `postgres/schema.sql` and from every migration, which is
why production can never have one, and why `pg_restore --clean` (which drops only what the archive
contains) leaves it standing.

```bash
node scripts/staging-refresh-decision.mjs check-url --url "$STAGING_REFRESH_TARGET_URL" && \
env -u PGHOST -u PGHOSTADDR -u PGPORT -u PGDATABASE -u PGUSER -u PGPASSWORD \
    -u PGPASSFILE -u PGSERVICE -u PGSERVICEFILE -u PGOPTIONS \
  psql -X "$STAGING_REFRESH_TARGET_URL" -c \
  "create table if not exists staging_marker (note text primary key)"
```

⚠️ **Run it exactly as written — the `check-url &&` prefix included.** This is the only libpq call the
runbook asks a human to make, so it is the only one the script cannot wrap; the prefix applies the same
url-shape refusals the refresh uses (no `hostaddr`, no multi-host list, no unknown parameter), and `&&`
makes it fail closed. `PGHOSTADDR` in your shell redirects a libpq
connection while the URL still reads as staging — verified: a URL naming a nonexistent host connects
to `127.0.0.1` when `PGHOSTADDR=127.0.0.1` is set. Plant the marker through a redirected connection
and it lands on **production**, after which the refresh's marker check passes and `--clean` follows it
there. The script scrubs the same variables for every call it makes; this one-time command is the only
libpq call the runbook asks a human to make, so it carries the same armour. The refresh also refuses a
URL carrying connection parameters outside a small allowlist, `hostaddr` among them.

**Then read it back on PRODUCTION, and expect nothing.** The declare above is the only libpq call this
runbook asks a human to make, and the moment it can be misdirected the marker becomes a liability
rather than a guard — a production database that quietly acquired one would make every later target
check pass for a swapped pair:

```bash
env -u PGHOST -u PGHOSTADDR -u PGSERVICE psql -X "$PROD_URL" -tAc \
  "select to_regclass('public.staging_marker')"    # must print an EMPTY line
```

If that prints `staging_marker`, stop: production is marked, and `drop table staging_marker` on prod is
the fix. The refresh also refuses when the **source** carries the marker, which catches the swapped pair
from the other side — but a human read-back costs one command and does not depend on the script.

⚠️ **Never add `staging_marker` to `postgres/schema.sql` or `postgres/migrations/`.** The moment it
ships to prod it enters the dump archive, the restore drops it, and the marker guard dies silently. A
build-failing guard enforces this (`test/guards/staging-refresh.test.ts`).

### One-time: the staging variable set

Apply these on the staging `aios-team-brain` service, then **read them back** with
`railway variables -s aios-team-brain -e staging` — a push that reported ok is not proof the value
moved. This table is machine-checked against `STAGING_VARIABLES` in
`scripts/staging-refresh-decision.mjs`; the check is a documentation-drift guard, not a check on
Railway's real state, which is why the read-back is a required step and not a nicety.

| variable | expected | why |
|---|---|---|
| `GRAPHITI_URL` | unset | **The load-bearing one.** The refresh empties `graph_episodes`, so every restored item looks unprojected. `GRAPH_PROJECT_ENABLED=false` does **not** stop projection — it gates the interval poller only, while the admin "Project to graph now" button calls `runGraphProjection` directly. Unset, the projector returns before it opens the database. Set, one click bills real entity extraction across the whole restored corpus. |
| `NEO4J_URL` | unset | staging's own Neo4j holds demo-seed data; wired up it would render *demo* facts beside *prod-shaped* content. Cosmetic honesty, not safety — re-wiring this alone is safe. |
| `RESEND_API_KEY` | unset | staging's key is the same as production's, with a verified sender domain: an invite or magic-link triggered in staging reaches a **real person**. |
| `SMTP_URL` | unset | the invariant is "no mail **provider**": `deliver()` falls through Resend to SMTP, so unsetting one is a boundary only while the other happens to be empty. |
| `SENTRY_DSN` | unset | staging and production share the identical DSN; staging errors would land in prod's alerting. |
| `NEXT_PUBLIC_SENTRY_DSN` | unset | same, for browser events. |
| `SENTRY_AUTH_TOKEN` | unset | the DSNs are only the runtime half — releases and source maps upload at **build** time under this token (`next.config.ts`), into the same Sentry project prod uses. Deploy verification reads the running app's release tag, so staging releases degrade that signal. |
| `INGEST_POLL_ENABLED` | `false` | no second scheduler. |
| `GRAPH_PROJECT_ENABLED` | `false` | defence in depth — **not** the projection boundary (see `GRAPHITI_URL`). |
| `AUTO_FLIP_ENABLED` | `false` | nothing in staging flips a real team's access enforcement. |
| `SEED_DEMO` | `false` | no demo rows on top of prod-shaped data. |

### Running it

```bash
STAGING_REFRESH_SOURCE_URL="<prod DATABASE_PUBLIC_URL>" \
STAGING_REFRESH_TARGET_URL="<staging DATABASE_PUBLIC_URL>" \
  bash scripts/staging-refresh.sh
```

Neither URL has a default, on purpose: a default source is a second silent opinion about which
database production is, and a default target is the URL a `--clean` restore destroys.

The dump is written to a private temp file and **deleted on every exit path** — it contains production
items, member email addresses and API-key hashes, and a copy of production with no expiry date is not
something to leave in `/tmp`. Set `STAGING_REFRESH_DUMP=/path/to/file` to keep it (useful when debugging
a failed restore); it is then yours to delete.

`PG_BIN=/opt/homebrew/opt/postgresql@18/bin` pins the client binaries. The script refuses when
`pg_dump`'s major is **below** the server's — `pg_dump` cannot dump a newer server, and a mismatched
client is how a *partially* restored archive gets made. The refusal names the remedy.

### What the dump deliberately leaves out

Table **data** excluded (the tables themselves are created, empty):

- `integrations`, `member_secrets`, `gateway_connections` — every table carrying a `*_ciphertext`
  column, i.e. **reversible secrets**. Not a hand-kept list: a guard scans `postgres/schema.sql` plus
  the migrations for `*_ciphertext` columns and fails the build when one is missing from the exclusion
  set. `member_secrets` in particular holds write-capable Slack **user** tokens that
  `GET /api/v1/me/slack-token` hands back to an authenticated caller.
- `graph_episodes` — the graph activity ledger. Copied against staging's empty graph it drives the
  extraction verdict to "stalled", and the resulting synthetic `graph_extract` leg is the one
  **confirmation-exempt** leg in the system: no staleness threshold could ever clear it. A permanently
  red "graph extraction is broken" banner, manufactured by our own refresh.

Kept deliberately: `auth_users` / `auth_tokens` / `api_keys` / `agent_tokens` (hashes, not reversible
secrets — dropping them leaves nobody able to log into staging), `members`, and `ingest_runs` (its
legs go stale in staging, but that alarm is *thresholded* and *true*).

### After a refresh

- Staging renders prod-shaped **Postgres**. Graph-backed surfaces — the learning panel, `graph-query`,
  the semantic retrieval leg — render **empty by design**. Narrative arcs show prod's cached arcs for
  4h, then linger up to 48h before blanking.
- **The residual hazard, which no code here closes:** the emptied `graph_episodes` ledger means that if
  `GRAPHITI_URL` is ever set on staging, the whole restored corpus looks unprojected and projection
  starts billing real extraction. Three non-test entrypoints reach it — the scheduler, the admin
  button, and `scripts/graph-window-battery/run-projection.ts`.
- Staging is **disposable**: anything created there is destroyed by the next refresh.

### Builtin materialization during deploy and attended recovery

**STAGINGMARK-2 repairs markerless fleets during PRET-6 preDeploy**, including teams with
no builtin groups and fleets that never booted PRET-4. `schema.sql` defines the frozen
`materialize_builtin_membership_once()` function once; the migration calls it after the
permissive-team readiness refusal and before dropping the retired columns. It creates Everyone
and External, reconciles every member by tier in both directions, and stamps the marker last.
An already-marked fleet returns without membership writes, audits or materializer locks.

Reconcile failures (including a non-builtin group holding a reserved slug) halt the deploy.
Reconciliation, marker and column drops roll back together. Earlier schema/migrations have
already committed: the loader has no transaction around the entire replay. Resolve the reported
failure and retry; permissive teams still require the prior release's readiness/flip path.

On a marker miss the function locks `teams`, `members`, `groups`, `group_members`, then
`migration_markers` in SHARE ROW EXCLUSIVE mode and re-reads the marker. The migration sets
`lock_timeout` to 15 seconds per LOCK/drop statement: five locks plus the ACCESS EXCLUSIVE
column-drop upgrade can wait **6 × 15 s = 90 s**, not a fleet-size or total-runtime guarantee.
The deadlock-freedom premise is that no current application transaction spans two of those
five tables; a future `members` → `group_members` transaction would invalidate it. An older
release's multi-statement TypeScript materializer is not retroactively serialized by these locks.

**Never delete the marker as a repair recipe.** Marker loss cannot be distinguished from first
materialization and can restore deliberately removed memberships. Boot/tick already had this
behavior; preDeploy now performs it earlier.

**Attended recovery remains available**, particularly for older releases that still emit
“the PRET-4 builtin materialization has not completed” (the staging failure on 2026-09-05,
deploy `2e67246e`). The command reconciles before stamping; it never merely silences a guard:

```bash
DATABASE_URL="<the wedged database's URL>" npm run admin -- materialize-builtins
```

That is a **dry run**: it reports which fleet it believes it is pointed at, whether the marker is
absent, and how many teams would be reconciled. Nothing is written. Re-run with `--confirm` to do it.
The dry run is where you check the fleet line — on a confirmed run the output prints after the work,
so read it here, before committing to it.

⚠️ **Run it from a checked-out tree of the release you are trying to deploy** — not from the running
old image, which does not contain the command. Any machine with the repo and network access to the
database works.

⚠️ **`--confirm-production` is additionally required when the target carries no `staging_marker`**, i.e.
when it may be production. The dry run tells you which case you are in. Team identity deliberately is
**not** used for this: staging is a restore of production and holds the same team row, so a team slug
matches both databases equally.

The command is a **no-op when the marker is already present** — it reads and exits without writing —
so running it against a healthy fleet is harmless.

**The alternative, if you would rather not run a command against the database:** roll back to the
previous release in the Railway dashboard (never `railway up` — the Railway CLI is read-only here;
see §4 "Railway deploy safety"). That release boots, its startup materialization stamps the marker, and the blocked deploy then applies. This
is an older-release recovery option; current STAGINGMARK-2 deployments perform marker repair themselves.
