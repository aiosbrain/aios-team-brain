-- 0001 core tenancy: teams, members, api_keys, audit_log, rate_limits
-- RLS is default-deny: every table has RLS enabled; only the policies below
-- grant access. The sync API authenticates API keys itself and writes with the
-- service role (bypasses RLS) — that path lives in lib/ingest and is audited.

create extension if not exists citext;

-- ── enums ───────────────────────────────────────────────────────────────────
create type member_role as enum ('admin', 'lead', 'member');
create type member_status as enum ('invited', 'active', 'disabled');
-- Tier vocabulary per docs/brain-api.md (aios-workspace): canonical is
-- admin|team|external; `client` is normalized to `external` at ingest and the
-- `admin` value never reaches the database (422 at the API).
create type access_tier as enum ('team', 'external');

-- ── tables ──────────────────────────────────────────────────────────────────
create table teams (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  name text not null,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  auth_user_id uuid references auth.users(id) on delete set null,
  email citext not null,
  display_name text not null,
  actor_handle text not null,           -- matches sync payload `actor`, e.g. "alex"
  role member_role not null default 'member',
  tier access_tier not null default 'team',  -- visibility ceiling
  status member_status not null default 'invited',
  created_at timestamptz not null default now(),
  unique (team_id, email),
  unique (team_id, actor_handle)
);
create index members_auth_user_idx on members (auth_user_id);

create table api_keys (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  key_id text not null unique,          -- public prefix, e.g. "7f3a9c"
  key_hash text not null,               -- sha256(secret); the secret is never stored
  name text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create table audit_log (
  id bigint generated always as identity primary key,
  team_id uuid references teams(id) on delete cascade,
  actor_kind text not null check (actor_kind in ('member', 'api_key', 'system')),
  member_id uuid,
  api_key_id uuid,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb not null default '{}',
  ip inet,
  created_at timestamptz not null default now()
);
create index audit_log_team_time_idx on audit_log (team_id, created_at desc);

create table rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, window_start)
);

-- ── private helper schema (not exposed via the Data API) ───────────────────
create schema if not exists private;

-- Append-only audit log: no UPDATE/DELETE, even by service-role mistakes.
create or replace function private.audit_protect()
returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;

create trigger audit_log_protect
  before update or delete on audit_log
  for each row execute function private.audit_protect();

-- Helpers for RLS. SECURITY DEFINER is required to avoid recursive RLS on
-- members; they live in the unexposed `private` schema and are anchored to
-- auth.uid() internally, per Supabase security guidance.
create or replace function private.my_team_ids()
returns setof uuid
language sql security definer stable
set search_path = public
as $$
  select team_id from members
  where auth_user_id = (select auth.uid()) and status = 'active'
$$;

create or replace function private.my_tier(p_team uuid)
returns access_tier
language sql security definer stable
set search_path = public
as $$
  select tier from members
  where team_id = p_team and auth_user_id = (select auth.uid()) and status = 'active'
  limit 1
$$;

create or replace function private.my_role(p_team uuid)
returns member_role
language sql security definer stable
set search_path = public
as $$
  select role from members
  where team_id = p_team and auth_user_id = (select auth.uid()) and status = 'active'
  limit 1
$$;

create or replace function private.my_member_id(p_team uuid)
returns uuid
language sql security definer stable
set search_path = public
as $$
  select id from members
  where team_id = p_team and auth_user_id = (select auth.uid()) and status = 'active'
  limit 1
$$;

-- Lock the helpers down to the roles that need them.
revoke all on function private.audit_protect() from public;
revoke all on function private.my_team_ids() from public;
revoke all on function private.my_tier(uuid) from public;
revoke all on function private.my_role(uuid) from public;
revoke all on function private.my_member_id(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.my_team_ids() to authenticated;
grant execute on function private.my_tier(uuid) to authenticated;
grant execute on function private.my_role(uuid) to authenticated;
grant execute on function private.my_member_id(uuid) to authenticated;

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table teams enable row level security;
alter table members enable row level security;
alter table api_keys enable row level security;
alter table audit_log enable row level security;
alter table rate_limits enable row level security;

-- teams: members see their own team(s); no client-side mutations.
create policy teams_select on teams for select
  to authenticated
  using (id in (select private.my_team_ids()));

-- members: see your team's roster; admins manage it.
create policy members_select on members for select
  to authenticated
  using (team_id in (select private.my_team_ids()));

create policy members_admin_insert on members for insert
  to authenticated
  with check (private.my_role(team_id) = 'admin');

create policy members_admin_update on members for update
  to authenticated
  using (private.my_role(team_id) = 'admin')
  with check (private.my_role(team_id) = 'admin');

-- api_keys: admin-only, and key_hash is never readable by clients
-- (column-level revoke below).
create policy api_keys_admin_select on api_keys for select
  to authenticated
  using (private.my_role(team_id) = 'admin');

create policy api_keys_admin_insert on api_keys for insert
  to authenticated
  with check (private.my_role(team_id) = 'admin');

create policy api_keys_admin_update on api_keys for update
  to authenticated
  using (private.my_role(team_id) = 'admin')
  with check (private.my_role(team_id) = 'admin');

revoke select (key_hash) on api_keys from authenticated;
revoke insert (key_hash) on api_keys from authenticated;
revoke update (key_hash) on api_keys from authenticated;

-- audit_log: admins read; nobody writes from the client (service role only).
create policy audit_admin_select on audit_log for select
  to authenticated
  using (team_id in (select private.my_team_ids())
         and private.my_role(team_id) = 'admin');

-- rate_limits: service-role only — no authenticated policies at all.
