-- 0008 (legacy supabase mode) ingestion connections for the Integrations settings page.
-- Canonical schema is postgres/schema.sql; this mirrors it for DB_BACKEND=supabase.
-- Holds an ENCRYPTED secret (AES-256-GCM via lib/secrets) — never plaintext. RLS: admins
-- manage; the secret_ciphertext column is revoked from clients (like api_keys.key_hash),
-- so even an admin select can't read it back — only the service role (sidecar endpoint) can.

create table connections (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  source text not null,
  name text not null,
  config jsonb not null default '{}',
  secret_ciphertext text,
  enabled boolean not null default true,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, name)
);
create index connections_team_idx on connections (team_id, source);

alter table connections enable row level security;

create policy connections_admin_select on connections for select
  to authenticated
  using (team_id in (select private.my_team_ids()) and private.my_role(team_id) = 'admin');

create policy connections_admin_insert on connections for insert
  to authenticated
  with check (private.my_role(team_id) = 'admin');

create policy connections_admin_update on connections for update
  to authenticated
  using (private.my_role(team_id) = 'admin')
  with check (private.my_role(team_id) = 'admin');

create policy connections_admin_delete on connections for delete
  to authenticated
  using (private.my_role(team_id) = 'admin');

-- The encrypted secret is never readable by client roles (defense in depth atop encryption).
revoke select (secret_ciphertext) on connections from authenticated;
revoke insert (secret_ciphertext) on connections from authenticated;
revoke update (secret_ciphertext) on connections from authenticated;
