-- AIO-1170: durable evidence for an empty NEW channel's namespace readiness.
-- Additive on populated databases; the historical path repair is a separate packet.
create table if not exists slack_namespace_readiness_proofs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  raw_channel_id text not null check (raw_channel_id ~ '^[A-Za-z0-9]+$'),
  gate_revision bigint not null check (gate_revision >= 0),
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9]+$'),
  integration_id uuid not null,
  binding_id uuid not null,
  config_revision text not null check (config_revision ~ '^[0-9a-f]{64}$'),
  public_checked_at timestamptz not null,
  proof_kind text not null default 'new_channel_empty_scan'
    check (proof_kind = 'new_channel_empty_scan'),
  legacy_rows_found integer not null check (legacy_rows_found = 0),
  completed_at timestamptz not null default clock_timestamp(),
  unique (team_id, raw_channel_id, gate_revision)
);
create index if not exists slack_namespace_readiness_proofs_gate_idx
  on slack_namespace_readiness_proofs (team_id, raw_channel_id, id);
