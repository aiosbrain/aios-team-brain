-- 0005 policy engine (Organ 6): policy rules + approval queue.
-- The constitutional layer — what an actor may do autonomously, what needs human
-- approval, what is denied. DEFAULT-DENY: an action with no matching `allow` rule is
-- denied (mirrors the RLS posture). Enforcement is performed by callers via lib/policy;
-- the future action layer (Organ 4) authorizes here before acting. RLS as everywhere:
-- team members read their team's policies/queue; admins & leads manage and decide.

create type policy_effect as enum ('allow', 'deny', 'require_approval');
create type approval_status as enum ('pending', 'approved', 'denied', 'expired');

create table policies (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  priority integer not null default 0,        -- higher wins; ties → most restrictive effect
  description text not null default '',
  -- subject matchers; null = wildcard (matches any principal on that dimension)
  subject_role member_role,
  subject_tier access_tier,
  subject_actor text,                          -- actor_handle, null = any
  action text not null,                        -- glob, e.g. 'item.write', 'agent.spawn', '*'
  resource text not null default '*',          -- glob, e.g. 'project:acme/*'
  effect policy_effect not null,
  enabled boolean not null default true,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index policies_team_idx on policies (team_id, enabled, priority desc);

create table approval_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  requested_by_member uuid references members(id) on delete set null,
  requested_by_actor text not null default '', -- acting principal's handle (may be an agent)
  action text not null,
  resource text not null,
  context jsonb not null default '{}',          -- request payload / rationale for the reviewer
  matched_policy_id uuid references policies(id) on delete set null,
  status approval_status not null default 'pending',
  decided_by uuid references members(id) on delete set null,
  decided_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now()
);
create index approval_requests_team_status_idx
  on approval_requests (team_id, status, created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table policies enable row level security;
alter table approval_requests enable row level security;

-- policies: team members read; admins & leads manage. (Service role bypasses RLS for
-- server-side authorize() reads, same as the ingest path.)
create policy policies_select on policies for select
  to authenticated
  using (team_id in (select private.my_team_ids()));

create policy policies_manage_insert on policies for insert
  to authenticated
  with check (private.my_role(team_id) in ('admin', 'lead'));

create policy policies_manage_update on policies for update
  to authenticated
  using (private.my_role(team_id) in ('admin', 'lead'))
  with check (private.my_role(team_id) in ('admin', 'lead'));

create policy policies_manage_delete on policies for delete
  to authenticated
  using (private.my_role(team_id) in ('admin', 'lead'));

-- approval_requests: team members see their team's queue and may file a request;
-- only admins & leads decide (update status).
create policy approvals_select on approval_requests for select
  to authenticated
  using (team_id in (select private.my_team_ids()));

create policy approvals_insert on approval_requests for insert
  to authenticated
  with check (team_id in (select private.my_team_ids()));

create policy approvals_decide_update on approval_requests for update
  to authenticated
  using (private.my_role(team_id) in ('admin', 'lead'))
  with check (private.my_role(team_id) in ('admin', 'lead'));
