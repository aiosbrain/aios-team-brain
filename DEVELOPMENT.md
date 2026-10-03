# Development — AIOS Team Brain

Get the brain running locally and know which command catches which failure. New here? Read this,
then [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to land a change. The deep map of where data
lives is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the conventions an agent must follow are
[`AGENTS.md`](AGENTS.md).

## Prerequisites

- **Node 20+** (Next.js 16 / App Router).
- **Docker** — only for the ephemeral test Postgres (`npm run db:test:up`) and, if you don't have
  a Postgres handy, for local dev too.
- **git**, and (recommended) the `gh` CLI for PRs.
- An **Anthropic API key** is *optional* for development — the dashboard, ingest, and all tests run
  without it; only live NL queries need an LLM (cloud key or a local endpoint — see
  [`docs/PROVIDERS.md`](docs/PROVIDERS.md)).

## First run

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local` and set, at minimum:

```bash
DATABASE_URL=postgres://app:app@localhost:5434/app_test   # see "Where do I get a DATABASE_URL?"
AUTH_SECRET=<paste 32 random bytes — command below>
APP_URL=http://localhost:3000
# ANTHROPIC_API_KEY=sk-ant-...   # optional; only for live queries
```

Generate `AUTH_SECRET` (signs the session cookie):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then load the schema, seed demo data, and start ONE dev server:

```bash
npm run pg:schema     # load postgres/schema.sql (canonical, idempotent) into DATABASE_URL
npm run dev:seed      # demo team (aios) + Northwind + Veridian graph
npm run dev:login     # the dev server, in the foreground, on http://127.0.0.1:3000 — local dev-login ON
```

Login is invite-only. `npm run dev:login` **is** the dev server (`AIOS_DEV_LOGIN=1 next dev --hostname
127.0.0.1`): it stays in the foreground, prints no link and mints nothing by itself. With it running,
open this in a browser on the same machine to be signed in as the seeded admin — no email needed:

```
http://127.0.0.1:3000/auth/dev-login?email=alex@demo.aios.local&next=/t/demo
```

The bypass signs in as *any* email with no credential check, so it is off unless the server was
started this way, answers only local requests (`127.0.0.1` / `localhost` on the server's own port)
and never exists in a production build. Keep it on loopback, don't persist `AIOS_DEV_LOGIN=1` in
`.env.local`, and never point it at a shared, staging or production database or `AUTH_SECRET` — the
full list of caveats is in [`README.md`](README.md) §2.7.
For another port: `npm run dev:login -- --port 4000`, and use that port in the URL.

Prefer not to enable it? Run plain `npm run dev` **instead** (not alongside — one server) and sign
in with the password `npm run admin -- create-member` prints; under plain `npm run dev` the URL above
is a `404`.

> **Where do I get a `DATABASE_URL`?** Easiest: reuse the test Postgres container —
> `npm run db:test:up` starts one on `localhost:5434` (user/pass/db = `app`/`app`/`app_test`) and
> loads the schema. Point `DATABASE_URL` at it as above. Or run your own
> (`docker run -e POSTGRES_PASSWORD=app -e POSTGRES_USER=app -e POSTGRES_DB=app -p 5432:5432 postgres:16`)
> and use `postgres://app:app@localhost:5432/app`. For a managed provider that requires TLS (e.g.
> Railway) also set `PGSSL=require`.

## Tests — which tier catches what

Put a spec-derived test in the tier that catches *its* failure mode (full rationale in
[`AGENTS.md` §4](AGENTS.md)):

| Tier | Command | Runs against | Catches |
|---|---|---|---|
| **unit** | `npm test` | nothing (pure) | parse/format, pure logic, **all drift/contract guards** |
| **data-mechanics** | `npm run db:test:up` then `npm run test:datamechanics:local` | **real Postgres**, stubbed model | persistence & access: write→store→read, dedup, diff-sync, **tier isolation** |
| **integration** | `bash scripts/e2e.sh` | API routes over a real DB + the cross-process sync loop | routing, auth, tier-422 |
| **docs guard** | `npm run check:docs` | the doc drift blocks | a route/table/source added without updating `docs/ARCHITECTURE.md` |
| **lint** | `npm run lint` | — | style/correctness lints |

Notes:
- The data-mechanics tier **requires `DATABASE_TEST_URL`** and refuses to fall back to a dev/prod
  URL. Use `npm run test:datamechanics:local` (it sets the URL after `db:test:up`), never bare
  `test:datamechanics` unless the env var is already set.
- `npm run db:test:down` tears the container down. The container can stop between sessions — if a
  data-mechanics run prints `ECONNREFUSED ...:5434`, just re-run `npm run db:test:up`.
- **The dev-login wire carrier** (`npm run test:http:dev-login`, AIO-1210) proves `/auth/dev-login`
  over a real loopback socket: the production build refuses under both runtime modes, then real
  `next dev` children with the opt-in off and on. Run it from CI or a **clean** checkout only — it
  refuses (never deletes) a checkout holding any Next-loaded env file such as `.env.local`, so use a
  separate clean copy rather than your configured one:
  ```bash
  npm run db:test:up
  npm run test:http:dev-login:build    # the ordinary `npm run build`, recorded against the current sources
  DATABASE_TEST_URL=postgres://app:app@localhost:5434/app_test npm run test:http:dev-login
  ```
  The carrier never builds: it consumes that build and refuses if its record is missing or stale
  (rebuild with the same command after any source change). It accepts only a loopback `_test`
  database, starts and stops its own servers on its own ports, and reports a held `next dev` lock or
  a failed start as a named `SETUP_FAILURE` — stop your own dev server first; it will not.
- **`npm run db:test:up` always starts FROM ZERO** (`scripts/db-test-up.sh`: `down -v`, then `up`,
  then load the schema). It is therefore safe to re-run against any prior state — you no longer
  have to remember `db:test:down` first. Two consequences worth knowing:
  - it is **destructive to the shared :5434 DB**, by design. If another agent/session is mid-run
    against it, you have just wiped their data — give your worktree its own container with
    `npm run test:datamechanics:iso` instead.
  - if the schema load fails, the command **removes the container** rather than leaving it up with
    a half-applied schema (which used to surface as confusing `relation "…" does not exist` errors
    instead of a clean connection refusal). Fix the failure and re-run.
  This matters because a data-mechanics run leaves DDL behind — the PRET-6 test re-adds the retired
  `teams.access_enforcement` column at its historical `'permissive'` default, and the harness
  truncates rows, not DDL. Replaying the migrations onto that state hit the (correct, production)
  PRET-6 guard: `PRET-6 refused: permissive team(s) remain`. The guard is unchanged; the bring-up
  no longer routes a local test DB through a production-upgrade replay it cannot get out of.

## Deploy / schema rollout

Production is Postgres on Railway, and **the deploy applies the schema itself** — `railway.json`
runs `npm run pg:schema` as its `preDeployCommand`, from the deployed artifact's tree.

⛔ **Do not run `npm run pg:schema` against prod by hand.** It loads from YOUR checkout
(`loadSchema({ cwd = process.cwd() })`), and since the 2026-09-06 cutover ordinary work lands on
`staging` while production tracks the tagged release — so a local run applies **unreleased
migrations** to production. This section used to instruct exactly that; it was near-safe only while
`main` was both trunk and production, and the cutover ended that. `docs/OPS.md` and the
`railway-deploy-verify` skill already said never to do it.

Instead: confirm the platform started a new build and that its preDeploy step succeeded (CI webhooks
get dropped — re-trigger from the Railway dashboard if the latest deploy predates the merge).

## Bootstrapping a fresh instance (first team + admin)

AIOS is self-hosted per organization (see CLAUDE.md §5) — there's no public signup. The first
team and its first admin are created once, with no hand-written SQL, by chaining two idempotent
CLI commands (against the target `DATABASE_URL` — prod uses the Railway DB):

```bash
npm run admin -- create-team <slug> --name "<Display Name>"
npm run admin -- create-member <you@org.com> --name "<Your Name>" --handle <you> --role admin --team <slug>
```

Both are safe to re-run: `create-team` returns the existing row for an already-used slug, and
`create-member` takes `--upsert` if you need to re-run it. From here, follow "Giving a new
contributor brain access" below to invite everyone else onto the same team.

## Giving a new contributor brain access (admins)

People are invite-only; machines (the `aios` CLI / sidecar) use a per-member API key. To onboard
someone, an admin runs (against the target `DATABASE_URL` — prod uses the Railway DB):

```bash
npm run admin -- create-member <email> --name "<Display Name>" --handle <actor-handle> --role member --team aios
npm run admin -- issue-key <email> --name "<their-laptop>" --team aios
# → prints aios_<key_id>_<secret> ONCE. Send it to them over a secure channel; it is sha256 at rest.
npm run admin -- login-link <email> --team aios            # optional: a magic link to sign into the dashboard
```

`npm run admin -- list-members` / `list-keys` show the current state. The full contributor journey
(scaffold a workspace → connect → first push → first PR) lives in the public docs under
**Getting Started → Onboarding a contributor**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:5434` in data-mechanics | the test container is down → `npm run db:test:up` |
| data-mechanics refuses to run (`requires DATABASE_TEST_URL`) | use `npm run test:datamechanics:local` |
| `relation "..." does not exist` / empty dashboard | schema/seed not loaded → `npm run pg:schema && npm run dev:seed` |
| auth/cookie errors | `AUTH_SECRET` unset in `.env.local` |
| invite/magic links point at the wrong host | set `APP_URL` to your absolute base URL |
| live query errors, everything else works | no LLM configured — set `ANTHROPIC_API_KEY` or `LLM_BASE_URL` ([`docs/PROVIDERS.md`](docs/PROVIDERS.md)) |
