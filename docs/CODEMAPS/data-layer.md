# CODEMAP — data layer (Postgres)

> Last verified against code: 2026-07-03. Code wins; fix this map in the same PR.

How the brain talks to its database. **Postgres is the one and only backend**, reached through the
`lib/db/pg` adapter and surfaced to the app as a single shared client type, `DbClient`
(`lib/db/types.ts`). Canonical schema = `postgres/schema.sql`. See `docs/ARCHITECTURE.md`
§Sources-of-truth and the access-control invariant before changing anything here.

## Data-client factories

| File | Role |
|---|---|
| `lib/db/server.ts` | `serverClient()` — session-scoped `DbClient`, backed by the pg adapter. |
| `lib/db/admin.ts` | `adminClient()` — service-role `DbClient`, the same pg adapter. Used by `lib/ingest`, `/api/v1/*`, seed. |
| `lib/db/types.ts` | `DbClient` — the shared client type both factories return. |

## Postgres adapter (`lib/db/pg/`)

A PostgREST-shaped query layer over `pg` — this is the query API the whole app calls (`.from()`
chains, filters, embeds).

| File | Role |
|---|---|
| `pool.ts` | Singleton `pg.Pool` over `DATABASE_URL` (SSL auto for managed providers); `runSql()`. |
| `client.ts` | `PgClient` — `.from(table)` → `PgQuery`; `.rpc('rate_limit_hit', …)`. It is the `DbClient`; has no `.auth`. |
| `query-builder.ts` | `PgQuery` — the exact subset the app uses: select + embedded resources + `(count)`/head + FTS `textSearch` + JSON `->>'` filters + the filter/order/limit chain + insert/update/upsert/delete. **Throws loudly on anything outside the catalogued subset** (so an unsupported query fails fast, not silently). |
| `relationships.ts` | Embedded-resource (`projects(slug)`-style) join resolution. |

## Auth (`lib/auth/`)

| File | Role |
|---|---|
| `session.ts` | `getSessionUser()`/`signOut()` — the single "who's signed in?" entry point (reads the signed cookie). |
| `guard.ts` | `currentMember(teamId)` → `{id, role, tier}` or null. **The app-level access check** (there is no RLS). |
| `pg-session.ts` | `jose`-signed session token in an httpOnly cookie. |
| `pg-login.ts`, `mailer.ts` | Passwordless / magic-link issue+verify (single-use, expiring `auth_tokens`), SMTP/Resend via the mailer. |

## Access enforcement — the standing invariant

**No RLS.** Tier isolation is enforced **entirely in app code** — `/api/v1/items*` and
`lib/query/retrieve.ts` re-apply `.eq("access","external")` for external principals, and dashboard
reads in `app/t/[team]/*` route through the **`lib/auth/visibility` choke-point**
(`visibleItems`/`canSeeAccess`), enforced by `test/guards/dashboard-tier-filter.test.ts` and proven
by the data-mechanics tier. A missing `access`/tier filter has **no DB backstop**. ✅ (the earlier
dashboard-leak gap is closed.)

## Schema + local test DB

- `postgres/schema.sql` — **the canonical schema** (drift-guarded source of truth): no RLS /
  `auth.users` coupling / pgvector, plus local `auth_users`/`auth_tokens` and a real
  `rate_limit_hit()`. Keeps the generated `search` tsvector column. Loader: `npm run pg:schema`
  (idempotent — also the prod rollout step against Railway's `DATABASE_URL`).
- `postgres/migrations/*.sql` — additive deltas `schema.sql` can't express on an existing DB
  (`alter table … add column if not exists`, backfills). The only migrations directory; applied
  after `schema.sql` by `pg:schema` in lexical order.
- `compose.test.yml` + `npm run db:test:up` — ephemeral test Postgres (port 5434, tmpfs) loaded
  from `schema.sql` (migrate-from-zero = replay guard); target of the data-mechanics tier.
