-- AIO-1167 Batch 2 closure: invalidate arc summaries synthesized before source-level audience
-- authorization became part of the prompt boundary. The marker makes this a one-time barrier on
-- replaying schema migrations; advancing every existing team's durable epoch also fences a rolling
-- old process that tries to republish a pre-policy payload after this cache purge.

create table if not exists migration_markers (
  name text primary key,
  at timestamptz not null default now()
);

with first_run as (
  insert into migration_markers(name)
  values ('aio1167_arc_input_authorization_v1')
  on conflict (name) do nothing
  returning 1
), advanced as (
  update team_authorization_epochs
     set epoch=epoch+1, updated_at=now()
   where exists (select 1 from first_run)
  returning team_id
)
delete from arc_cache c
 using advanced a
 where c.team_id=a.team_id;
