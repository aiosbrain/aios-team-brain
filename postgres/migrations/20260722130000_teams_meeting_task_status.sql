-- Which category extracted MEETING action items land in when pushed to the PM tool (Linear/Plane).
-- A brain task status mapped to the provider's state group by desiredStateForStatus. Null →
-- 'backlog' (the historical default). Set from Admin → Integrations (radio). Additive + idempotent.
alter table teams add column if not exists meeting_task_status text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_meeting_task_status_check') then
    alter table teams add constraint teams_meeting_task_status_check
      check (meeting_task_status in ('backlog', 'ready', 'in_progress', 'done'));
  end if;
end $$;
