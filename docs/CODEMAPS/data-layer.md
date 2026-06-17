# CODEMAP — data layer (dual backend)

> Last verified against code: 2026-06-17. Code wins; fix this map in the same PR.

How the brain talks to its database. One Supabase-shaped data API, two implementations
selected at runtime by `DB_BACKEND`. See `docs/ARCHITECTURE.md` §Sources-of-truth and the
access-control invariant before changing anything here.

## Backend selection

| File | Role |
|---|---|
| `lib/db/backend.ts` | `dbBackend()` reads `DB_BACKEND` (`supabase` default, `postgres` self-host); `isPostgresBackend()`. Import-safe from client + server. |
| `lib/supabase/server.ts` | `serverClient()` — session-scoped data client. supabase: `@supabase/ssr` (RLS via the user JWT). postgres: the pg adapter (no RLS). |
| `lib/supabase/admin.ts` | `adminClient()` — service-role data client. supabase: service-role key (bypasses RLS). postgres: same pg adapter (there is no RLS to bypass). Used by `lib/ingest`, `/api/v1/*`, seed. |

## Postgres adapter (`lib/db/pg/`)

A PostgREST-compatible query layer over `pg`, so the ~34 supabase-js call sites run unchanged.

| File | Role |
|---|---|
| `pool.ts` | Singleton `pg.Pool` over `DATABASE_URL` (SSL auto for managed providers); `runSql()`. |
| `client.ts` | `PgClient` — `.from(table)` → `PgQuery`; `.rpc('rate_limit_hit', …)`. Cast to `SupabaseClient` at the factory boundary; has no `.auth`. |
| `query-builder.ts` | `PgQuery` — the exact subset the app uses: select + embedded resources + `(count)`/head + FTS `textSearch` + JSON `->>'` filters + the filter/order/limit chain + insert/update/upsert/delete. **Throws loudly on anything outside the catalogued subset** (so an unsupported query fails fast, not silently). |
| `relationships.ts` | Embedded-resource (`projects(slug)`-style) join resolution. |

## Auth (`lib/auth/`) — backend-agnostic

| File | Role |
|---|---|
| `session.ts` | `getSessionUser()`/`signOut()` — the single "who's signed in?" entry point. supabase: Supabase Auth; postgres: signed httpOnly JWT cookie. |
| `guard.ts` | `currentMember(teamId)` → `{id, role, tier}` or null. **The app-level access check that replaces RLS in postgres mode** (defense-in-depth in supabase mode). |
| `pg-session.ts` | `jose`-signed session token (postgres mode). |
| `pg-login.ts`, `mailer.ts`, `supabase-auth.ts` | Magic-link issue/verify (single-use, expiring `auth_tokens`), SMTP via nodemailer, Supabase-auth client. |

## Access enforcement — the asymmetry that matters

- **supabase:** the `items` RLS policy enforces team + **tier** isolation in the DB.
- **postgres:** **no RLS.** Isolation is whatever the app code applies:
  - `/api/v1/items*` and `lib/query/retrieve.ts` re-apply `.eq("access","external")` for external
    principals → safe on both backends (covered by data-mechanics tests).
  - 🔴 dashboard reads in `app/t/[team]/*` do **not** filter by tier → they lean on RLS, which is
    absent in postgres mode. Tracked in `ARCHITECTURE.md` §Invariants.

## Schema + local test DB

- `postgres/schema.sql` — the postgres-mode schema: the Supabase migrations minus RLS / `auth.users`
  coupling / pgvector, plus local `auth_users`/`auth_tokens` and a real `rate_limit_hit()`. Keeps
  the generated `search` tsvector column. Loader: `npm run pg:schema`.
- `supabase/migrations/*.sql` — the supabase-mode schema (RLS included).
- `compose.test.yml` + `npm run db:test:up` — ephemeral test Postgres (port 5434, tmpfs) loaded
  from `schema.sql` (migrate-from-zero = replay guard); target of the data-mechanics tier.
