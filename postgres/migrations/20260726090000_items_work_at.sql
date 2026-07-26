-- Persist WORK TIME on items (Pass-1 review R1). "When did this work happen" was a per-surface
-- derivation, not data: `lib/ingest/work-time.resolveWorkTime` unified the *derivation*, but nothing
-- wrote the answer down — so any consumer that couldn't run TS over `frontmatter` (a SQL window, an
-- ORDER BY, the retrieval recency legs) fell back to `synced_at`.
--
-- `synced_at` is bumped by EVERY re-sync tick, so that fallback re-dates old work as today: the graph
-- stamps months-old docs "now" and floods the newest-facts pool (H4), the timeline's window+limit is
-- really "the 2000 most recently PUSHED rows" (H5), and "latest docs" answers resurface old content
-- after any re-scan (M3). One column removes the fallback everywhere at once.
--
-- `work_at_from_source` records whether the SOURCE dated it or we fell back. Surfaces legitimately
-- differ on what to do with a guess — the timeline drops an undated item, the projector accepts it —
-- so the distinction has to be readable rather than re-derived from frontmatter at each call site.
-- (`items.created_at` is already the never-bumped first-seen timestamp, so it IS the honest fallback;
-- no second column for it.)
--
-- REPLAY-SAFE: add-column-if-not-exists with a default, no destructive backfill.
alter table items add column if not exists work_at timestamptz;
alter table items add column if not exists work_at_from_source boolean not null default false;

-- Default set BEFORE the backfill. Belt-and-braces rather than load-bearing: `pg-load-schema` runs each
-- migration file as ONE implicit transaction, and the first `alter table` here takes ACCESS EXCLUSIVE
-- until commit, so no concurrent insert can slip a NULL between the UPDATE and the SET NOT NULL anyway.
-- It matters for the OTHER window — `pg:schema` is the pre-deploy step, so the old app keeps serving
-- afterwards with code that doesn't know the column, and the default is what makes its inserts valid.
-- (`alter column set default` does NOT backfill, so existing rows still take `created_at` below.)
alter table items alter column work_at set default now();

-- Backfill to the honest fallback, NOT to a guessed parse of frontmatter. A SQL date-parse over
-- source-controlled jsonb would need per-key casting with no `try_cast` in PG16, and a bad value in one
-- row would fail the whole deploy — the migration-replay lesson. Instead every existing row starts at
-- `created_at` / not-from-source, and CONVERGES on its own: every connector re-pushes every item each
-- 30-minute tick, and `ingestItem`'s unchanged-path heal recomputes `work_at` through the one resolver.
-- So the imprecise state lasts one sync cycle for live sources, and for a disconnected source
-- `created_at` is the honest answer anyway.
update items set work_at = created_at where work_at is null;
-- `created_at` is already NOT NULL (20260724120000), so this cannot propagate a NULL. Validating the
-- constraint scans the table under ACCESS EXCLUSIVE — fine at this size; a very large `items` would
-- want the NOT VALID + VALIDATE dance instead.
alter table items alter column work_at set not null;

-- The point of persisting it: SQL-native work windows and ordering (the timeline's day buckets, the
-- retrieval recency legs) instead of fetching by `synced_at` and filtering in JS.
create index if not exists items_team_work_at_idx on items (team_id, work_at desc);
