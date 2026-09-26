-- AIO-1170: insert-only application auth.test workspace evidence for an integration.
-- No backfill: a current binding cannot prove prior rotations or deleted integrations.
-- The integration UUID deliberately has no FK so deleting its credential row retains evidence.
create table if not exists slack_workspace_observations (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  integration_id uuid not null,
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9]+$'),
  first_observed_at timestamptz not null default clock_timestamp(),
  provenance_kind text not null default 'auth_test' check (provenance_kind = 'auth_test'),
  unique (team_id, integration_id, workspace_id)
);

-- A child row is removable only while its parent team is being deleted. PostgreSQL's
-- ON DELETE CASCADE runs after the parent row is gone. A direct observation DELETE
-- while the team exists is refused, including when issued inside another trigger.
-- Do not use pg_trigger_depth(): any nested caller could otherwise erase evidence.
-- Row protection does not claim privileged TRUNCATE/DDL resistance. A future cutover
-- must not treat this table alone as an exhaustive or tamper-proof historical census.
create or replace function protect_slack_workspace_observation()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' or exists (select 1 from teams where id = old.team_id) then
    raise exception using errcode = '23514',
      message = 'Slack workspace observation is immutable';
  end if;
  return old;
end;
$$;
do $$ begin
  if not exists (select 1 from pg_trigger
                 where tgname = 'slack_workspace_observations_immutable'
                   and tgrelid = 'slack_workspace_observations'::regclass
                   and not tgisinternal) then
    create trigger slack_workspace_observations_immutable
      before update or delete on slack_workspace_observations
      for each row execute function protect_slack_workspace_observation();
  end if;
end $$;
