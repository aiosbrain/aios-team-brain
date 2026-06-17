# CODEMAP — data layer (configurable backend)

> Last verified against code: 2026-06-17. Code wins; fix this map in the same PR.

How the brain talks to its database. **Configurable single backend** — one Supabase-shaped data API,
two implementations, exactly one selected at runtime by `DB_BACKEND`. **Postgres is the default and the
deployed target (Railway); Supabase is legacy/optional.** Canonical schema = `postgres/schema.sql`. See
`docs/ARCHITECTURE.md` §Sources-of-truth and the access-control invariant before changing anything here.

## Backend selection

| File | Role |
|---|---|
| `lib/db/backend.ts` | `dbBackend()` reads `DB_BACKEND` (`postgres` default/target; `supabase` legacy opt-in); `isPostgresBackend()`. Import-safe from client + server. |
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

## Access enforcement — the standing invariant

- **postgres (the target):** **no RLS.** Tier isolation is enforced **entirely in app code** —
  `/api/v1/items*` and `lib/query/retrieve.ts` re-apply `.eq("access","external")` for external
  principals, and dashboard reads in `app/t/[team]/*` route through the **`lib/auth/visibility`
  choke-point** (`visibleItems`/`canSeeAccess`), enforced by `test/guards/dashboard-tier-filter.test.ts`
  and proven by the data-mechanics tier. ✅ (the earlier dashboard-leak gap is closed.)
- **supabase (legacy):** the `items` RLS policy enforces team + tier isolation in the DB; the app-code
  checks above are defense-in-depth.

## Schema + local test DB

- `postgres/schema.sql` — **the canonical schema** (Postgres target; drift-guarded source of truth):
  no RLS / `auth.users` coupling / pgvector, plus local `auth_users`/`auth_tokens` and a real
  `rate_limit_hit()`. Keeps the generated `search` tsvector column. Loader: `npm run pg:schema`
  (idempotent — also the prod rollout step against Railway's `DATABASE_URL`).
- `supabase/migrations/*.sql` — the **legacy/derived** supabase-mode schema (RLS included), used only
  when `DB_BACKEND=supabase`.
- `compose.test.yml` + `npm run db:test:up` — ephemeral test Postgres (port 5434, tmpfs) loaded
  from `schema.sql` (migrate-from-zero = replay guard); target of the data-mechanics tier.
