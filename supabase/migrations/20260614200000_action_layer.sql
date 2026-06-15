-- 0006 action layer (Organ 4): policy-governed actions taken on behalf of the collective.
-- Every action is authorized through lib/policy before it runs (default-deny). The row is
-- the durable record of the request, the policy decision, and the outcome; `require_approval`
-- decisions link to approval_requests. RLS as everywhere: team members read their team's
-- actions; writes happen server-side (service role) from lib/actions, audited.

create type action_status as enum (
  'requested',         -- received, not yet decided
  'denied',            -- policy denied (or default-deny)
  'pending_approval',  -- policy requires human approval; see approval_request_id
  'running',           -- authorized, handler executing
  'succeeded',
  'failed'
);

create table actions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  -- acting principal (an agent acts on behalf of a member)
  member_id uuid references members(id) on delete set null,
  actor text not null default '',          -- actor_handle of the principal
  action_type text not null,               -- e.g. 'note.create', 'code.run'
  resource text not null default '*',       -- target the policy matched against
  params jsonb not null default '{}',
  status action_status not null default 'requested',
  decision text,                            -- 'allow' | 'deny' | 'require_approval'
  matched_policy_id uuid references policies(id) on delete set null,
  approval_request_id uuid references approval_requests(id) on delete set null,
  result jsonb not null default '{}',       -- handler output or error detail
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index actions_team_status_idx on actions (team_id, status, created_at desc);
create index actions_team_actor_idx on actions (team_id, actor);

alter table actions enable row level security;

-- team members read their team's action history; mutations are service-role only
-- (lib/actions), so there are no authenticated insert/update policies.
create policy actions_select on actions for select
  to authenticated
  using (team_id in (select private.my_team_ids()));
