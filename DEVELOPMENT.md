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

## First run (Postgres backend — the default)

```bash
npm install
cp .env.example .env.local
```

Edit `.env.local` and set, at minimum:

```bash
DB_BACKEND=postgres
NEXT_PUBLIC_DB_BACKEND=postgres
DATABASE_URL=postgres://app:app@localhost:5434/app_test   # see "Where do I get a DATABASE_URL?"
AUTH_SECRET=<paste 32 random bytes — command below>
APP_URL=http://localhost:3000
# ANTHROPIC_API_KEY=sk-ant-...   # optional; only for live queries
```

Generate `AUTH_SECRET` (signs the session cookie in Postgres mode):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then load the schema, seed demo data, and start the dev server:

```bash
npm run pg:schema     # load postgres/schema.sql (canonical, idempotent) into DATABASE_URL
npm run dev:seed      # demo team (aios) + Northwind + Veridian graph
npm run dev           # http://localhost:3000
```

Login is invite-only (magic link). For local dev, mint a session without email:

```bash
npm run dev:login     # prints a login link for the seeded admin
```

> **Where do I get a `DATABASE_URL`?** Easiest: reuse the test Postgres container —
> `npm run db:test:up` starts one on `localhost:5434` (user/pass/db = `app`/`app`/`app_test`) and
> loads the schema. Point `DATABASE_URL` at it as above. Or run your own
> (`docker run -e POSTGRES_PASSWORD=app -e POSTGRES_USER=app -e POSTGRES_DB=app -p 5432:5432 postgres:16`)
> and use `postgres://app:app@localhost:5432/app`. For a managed provider that requires TLS (e.g.
> Railway) also set `PGSSL=require`.

> **Legacy Supabase backend:** set `DB_BACKEND=supabase`, run `supabase start`, fill `.env.local`
> from `supabase status -o env`, and `supabase db reset` to migrate. New work targets Postgres;
> Supabase is opt-in and its migrations are legacy-scoped.

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

## Deploy / schema rollout

Production is Postgres on Railway. After a merge that changes `postgres/schema.sql`, run
`npm run pg:schema` against the prod `DATABASE_URL` and confirm the platform started a new build
(CI webhooks can be dropped — re-trigger if the latest deploy predates the merge).

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
| auth/cookie errors in Postgres mode | `AUTH_SECRET` unset in `.env.local` |
| invite/magic links point at the wrong host | set `APP_URL` to your absolute base URL |
| live query errors, everything else works | no LLM configured — set `ANTHROPIC_API_KEY` or `LLM_BASE_URL` ([`docs/PROVIDERS.md`](docs/PROVIDERS.md)) |
