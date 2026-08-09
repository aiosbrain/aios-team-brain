-- Access chain, Phase A slice 1 (spec §4): what an EXISTING database needs to catch up.
-- The three new tables (groups / group_members / project_groups) are created by schema.sql's
-- `create table if not exists` and need no delta here; this file carries only the changes
-- schema.sql cannot express on an existing DB:
--   1. members.kind ('human' | 'agent' | 'offroster') with its CHECK — full current value set,
--      per the constraint-replay rule in postgres/migrations/README.md.
--   2. (team_id, id) unique indexes on members/projects — the composite-FK targets the new
--      edge tables reference, so a cross-team edge is unrepresentable.

alter table members add column if not exists kind text not null default 'human'
  check (kind in ('human','agent','offroster'));

create unique index if not exists members_team_id_id_idx on members (team_id, id);
create unique index if not exists projects_team_id_id_idx on projects (team_id, id);
