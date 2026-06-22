-- brain-api v1.2 — task hierarchy + primary PM provider + projection bookkeeping.
-- Mirrors the additive changes in postgres/schema.sql (the canonical self-host target).
-- All idempotent so it is safe on an already-migrated database.

-- tasks: hierarchy/board fields. parent_row_key references the epic by row_key within
-- (team_id, project_id); integrity is enforced in app code (lib/ingest + task server actions),
-- not a DB FK. body is dashboard/DB-only and never round-trips through markdown.
alter table tasks add column if not exists parent_row_key text;
alter table tasks add column if not exists labels text[] not null default '{}';
alter table tasks add column if not exists priority text not null default 'none';
alter table tasks add column if not exists body text not null default '';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_priority_check') then
    alter table tasks add constraint tasks_priority_check check (priority in ('none', 'low', 'medium', 'high', 'urgent'));
  end if;
end $$;
create index if not exists tasks_team_parent_idx on tasks (team_id, project_id, parent_row_key);

-- teams: the single PM tool the brain projects into.
alter table teams add column if not exists primary_pm_provider text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_primary_pm_provider_check') then
    alter table teams add constraint teams_primary_pm_provider_check check (primary_pm_provider in ('plane', 'linear'));
  end if;
end $$;

-- task_pm_links: projection bookkeeping (skip-detection + Phase 5 divergence detection).
alter table task_pm_links add column if not exists last_projected_status text;
alter table task_pm_links add column if not exists projection_fingerprint text;
alter table task_pm_links add column if not exists provider_seen_status text;
