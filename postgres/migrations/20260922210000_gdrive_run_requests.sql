-- Durable Admin/manual Google Drive run queue. The Python sidecar claims through its immutable
-- connector principal and still acquires the ordinary generation/fence before provider work.
create table if not exists gdrive_run_requests (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  integration_id uuid not null references integrations(id) on delete cascade,
  requested_by uuid references members(id) on delete set null,
  trigger text not null default 'manual' check (trigger in ('manual','retry')),
  status text not null default 'pending' check (status in ('pending','running','complete','partial','failed','cancelled')),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  error text
);
create index if not exists gdrive_run_requests_claim_idx
  on gdrive_run_requests (team_id, integration_id, status, created_at);
create unique index if not exists gdrive_run_requests_one_active_idx
  on gdrive_run_requests (integration_id) where status in ('pending','running');
