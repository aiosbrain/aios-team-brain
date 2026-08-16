-- Access chain, Phase A slice 1 (spec §4): what an EXISTING database needs to catch up.
-- The three new tables (groups / group_members / project_groups) are created by schema.sql's
-- `create table if not exists` and need no delta here; this file carries only the changes
-- schema.sql cannot express on an existing DB:
--   1. members.kind ('human' | 'agent' | 'offroster') with a NAMED, drop-and-re-added CHECK —
--      the replay-repairable pattern (postgres/migrations/README.md; the integrations_type_check
--      incident): an inline CHECK on `add column if not exists` is skipped forever once the
--      column exists, so a later widening could never repair it. Widening this enum later means
--      updating THIS list (and schema.sql's) to the identical complete set.
--   2. (team_id, id) unique indexes on members/projects — the composite-FK targets the new
--      edge tables reference, so a cross-team edge is unrepresentable.

alter table members add column if not exists kind text not null default 'human';

do $$
begin
  alter table members drop constraint if exists members_kind_check;
  alter table members add constraint members_kind_check
    check (kind in ('human','agent','offroster'));
end $$;

create unique index if not exists members_team_id_id_idx on members (team_id, id);
create unique index if not exists projects_team_id_id_idx on projects (team_id, id);
