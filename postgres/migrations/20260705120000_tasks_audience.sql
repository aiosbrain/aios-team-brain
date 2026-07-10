-- H1 (audit 2026-07-05): tasks had NO tier column, so every task read filtered by team_id only
-- and returned internal task boards to an `external`-tier principal (unlike `decisions`, which
-- carries `audience`). Add `audience` mirroring decisions; a task inherits the visibility tier of
-- the item that materialized it (see lib/ingest materializeTasks). Default 'team' = safe-by-default:
-- external principals see nothing until a task is explicitly external-tier.
alter table tasks add column if not exists audience access_tier not null default 'team';
create index if not exists tasks_team_audience_idx on tasks (team_id, audience);
