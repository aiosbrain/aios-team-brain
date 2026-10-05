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
- **A shipped migration is immutable.** Once a file here has reached staging it is never edited
  again — not to fix a comment, and not to widen a value list. The file a database was upgraded
  with must stay the file in the repository. Change behaviour with a NEW migration.
- **Every REPLAYED CHECK/constraint must allow the FULL current value set — not the set as of
  the file's write date.** Because every file replays in order on every deploy, an *older*
  `drop + re-add … check (x in (…))` that omits a value a *newer* migration added will, once
  prod holds a row with that newer value, reject it and abort the release — even though each
  file is individually idempotent (the 2026-07-13 `integrations_type_check` incident).

  The two rules meet in the **replay-supersession contract**, `scripts/migration-replay-plan.mjs`.
  To widen an enumerated CHECK:
  1. add ONE new migration that drops and re-adds the constraint with the complete set;
  2. mirror the complete set into `schema.sql`;
  3. for **every earlier migration that re-adds the same constraint**, add an entry to
     `REPLAY_SUPERSESSIONS` naming that file, its git blob id
     (`git rev-parse <rev>:postgres/migrations/<file>`), the exact obsolete statements, and the
     new migration that owns the constraint. Do **not** edit the earlier file.

  The effective replay plan then omits exactly those obsolete statements — never the whole file,
  so a mixed-purpose migration still replays everything else — and the owning migration
  re-establishes the constraint on the same pass. `pg-load-schema.mjs` (the deploy) and
  `migrate-from-existing.mjs` (the upgrade lane) both execute that plan. It fails closed: a pinned
  file that changed, obsolete text that is not present exactly once, or an owner that sorts earlier
  or no longer defines the constraint aborts the load before a connection is even opened. (A
  migration set that does not contain the owner at all is a historical release state — the upgrade
  proofs replay those — and is run verbatim; the supersession is only in force alongside its owner.)
  `test/guards/migration-replay-plan.test.ts`, `enum-check-replay.test.ts` and
  `integrations-type-check-replay.test.ts` fail the build on an edited shipped file or on a
  narrower definition left replaying.

  Rolling BACK across a widening is not covered: a release from before the supersession replays the
  old files verbatim and will refuse a database that already holds a row with the new value.
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

One data-dependent case IS claimed, because it is the incident class the supersession contract
exists for: the **populated replay**. The lane deploys the current tree over the newest usable
release (or `--populated-from <ref>` for an exact prior state, such as the staging commit a branch
is based on), inserts a `gdrive` integration and a `gdrive_claim` context membership, replays the
whole deploy twice more, and requires both rows and both complete constraints to survive. Its
negative control then runs each superseded migration RAW and requires those rows to refuse it —
so a fixture that stops exercising the constraints turns the lane red instead of vacuous.

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
