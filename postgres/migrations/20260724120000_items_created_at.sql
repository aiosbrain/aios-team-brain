-- First-seen timestamp for an item — when this knowledge FIRST entered the brain, not when it was last
-- touched. `synced_at` is bumped every 30-min sync tick (the scheduler re-pushes every item), so it
-- measures re-sync churn, not growth: on prod 99.9% of items count as "synced in the last 30 days". The
-- dashboard "Knowledge growth" chart was bucketing on `synced_at` and therefore plotted churn, not new
-- knowledge. `created_at` is set once on insert (DB default) and never bumped, so it is the honest
-- growth signal. A single shared column (readable by every surface) rather than each reader re-deriving
-- min(item_versions.created_at). See lib/metrics/pulse.ts.
--
-- REPLAY-SAFE (migrations re-run on every rollout — postgres/migrations/README.md): the column is added
-- NULLABLE + NO DEFAULT, the backfill is guarded by `where created_at is null`, and the default/not-null
-- are set afterward. So the first rollout backfills every existing row exactly once; every later replay
-- matches zero rows — no clobber of already-set values, no full-table rewrite of `items` (WAL/lock
-- pressure on the largest table on the deploy path — cf. the 2026-07-13 lock incident).
alter table items add column if not exists created_at timestamptz;

-- Backfill only the not-yet-set rows to their TRUE first-seen: the earliest version row (first ingest
-- wrote a version; unchanged re-pushes do not), falling back to synced_at when an item somehow has no
-- versions. Guarded so replays are a no-op (all rows already non-null after the first rollout).
update items i
set created_at = coalesce(
  (select min(v.created_at) from item_versions v where v.item_id = i.id),
  i.synced_at
)
where i.created_at is null;

-- Now that every row has a value, lock in the insert-time semantics. Both are no-ops on replay/from-zero.
alter table items alter column created_at set default now();
alter table items alter column created_at set not null;

create index if not exists items_team_created_idx on items (team_id, created_at desc);
