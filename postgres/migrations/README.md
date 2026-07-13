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
- **A re-added CHECK/constraint must allow the FULL current value set — not the set as of
  the file's write date.** Because every file replays in order on every deploy, an *older*
  `drop + re-add … check (x in (…))` that omits a value a *newer* migration added will, once
  prod holds a row with that newer value, reject it and abort the release — even though each
  file is individually idempotent (the 2026-07-13 `integrations_type_check` incident). So when
  you widen an enumerated CHECK, update `schema.sql` **and every earlier migration that re-adds
  the same constraint** to the identical complete list. Where a guard enforces this
  (e.g. `test/guards/integrations-type-check-replay.test.ts`), it fails the build on drift.
- **Name as `YYYYMMDDHHMMSS_short_description.sql`.**
- **Mirror the change into `postgres/schema.sql`** so a from-zero load still produces the
  same shape — the file here is only what an *existing* DB needs to catch up.
- This is the Railway rollout path; `postgres/migrations/` is the only migrations directory.
