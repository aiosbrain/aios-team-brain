# postgres/migrations — additive deltas for the deployed `postgres` target

`postgres/schema.sql` is the canonical, idempotent schema, but it expresses every object
with `create table if not exists` / `create index if not exists`. That makes it safe to
re-run on a **fresh** database, but it is a **no-op on an existing table** — so adding a
column to a table that already exists in prod is silently skipped by `npm run pg:schema`.

This directory holds the additive deltas `schema.sql` cannot express on an existing DB:
`alter table … add column if not exists`, backfills, new constraints, etc. `npm run pg:schema`
loads `schema.sql` first, then applies every file here in **lexical filename order**.

Rules:
- **Idempotent only.** Use `add column if not exists`, `create index if not exists`,
  guarded `do $$ … $$` blocks. Files are replayed on every rollout and in the
  migrate-from-zero test (`npm run db:test:up`), so a non-idempotent file will break CI.
- **Name as `YYYYMMDDHHMMSS_short_description.sql`** (matches `supabase/migrations/`).
- **Mirror the change into `postgres/schema.sql`** so a from-zero load still produces the
  same shape — the file here is only what an *existing* DB needs to catch up.
- This is the `DB_BACKEND=postgres` (Railway) rollout path. `supabase/migrations/` remains
  the legacy supabase-only schema.
