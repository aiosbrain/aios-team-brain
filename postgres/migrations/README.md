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

## What actually checks the two rules above

Nothing a **fresh** database does can check them. `pg:schema` loads `schema.sql` first, and on an
empty DB that already creates every object in its final shape — so every migration replayed after it
is a no-op. `npm run db:test:up` runs exactly that path. Delete an additive migration and the whole
suite stays green; the fresh-DB load literally cannot observe it.

`scripts/migrate-from-existing.mjs` closes that. It loads a PRIOR schema state — a real released tag,
read straight out of git (`git show v0.7.0:postgres/schema.sql`), so there are no fixture files to
keep current — applies the current `schema.sql` + every migration forward exactly as a deploy does,
and asserts the resulting **catalog fingerprint** (columns/types/defaults/nullability, indexes,
constraints by name, enum labels *in enum sort order*, functions, triggers) is identical to a
from-zero build. Each build gets its own scratch database, created and dropped by the script.

Scope, stated plainly: those scratch databases are **empty**, so this checks a migration's
**structural** effect and not its **data** behaviour. A backfill's `update` touches no rows here, and
a row-dependent precondition never fires — `20260818210000_pret6_retire_access_enforcement.sql`
aborts a real rollout against a populated database and is green in this lane every time. Seeding a
fixture set that satisfies every migration's preconditions is real work and is not claimed.

```bash
DATABASE_TEST_URL=postgres://app:app@localhost:5434/app_test npm run test:migrate-from-existing
DATABASE_TEST_URL=… npm run test:migrate-from-existing:sweep   # nightly, exhaustive
```

Practical consequences when you add a migration:

- **Add a column to `schema.sql` and forget the migration → the lane goes red**, naming the column.
  That is the failure mode the fresh-DB path is blind to, and it is why this runs per-PR.
- **Add a migration and forget to mirror it into `schema.sql` → `--mirror-check` goes red.**
  Five objects predate the guard and are allowlisted in `MIRROR_EXCEPTIONS` with their reasons: three
  indexes (`chat_messages_search_idx`, `graph_episodes_pending_delete_idx`, `items_team_work_at_idx`)
  that do not live in `schema.sql`, because it runs BEFORE the migrations and a bare
  `create index if not exists` on a column the migration has not added yet is a hard error, not a
  skip (mirrorable if you also add the column with `alter table … add column if not exists`, the
  idiom `schema.sql` already uses 66 times — a choice, not an impossibility); and two named CHECKs (`members_kind_check`, `projects_kind_check`) deliberately owned by
  their migration so widening them stays replay-repairable. Anything NOT on that list is a red build.
- **Redefining a function an earlier migration also defines is fine but load-bearing.** The last
  writer wins on every deploy, so `schema.sql` must carry that same final body. The nightly sweep
  reports these chains by name. This is not hypothetical: `gateway_resolution_lease_protect()` was
  declared with `policy_version` immutable in `schema.sql` and re-created WITHOUT it by
  `20260714090000` on every rollout, so the stated invariant never held in any deployed database —
  found by this lane, fixed by `20260820120000_gateway_lease_policy_version_immutable.sql`.
