-- Per-member encrypted secrets (e.g. a member's own Slack USER token for "act as me").
-- DISTINCT from team `integrations.secret_ciphertext` (team-scoped, bot/read): per-member +
-- write-capable, written only by lib/member-secrets/manage.ts (audited single writer) and read
-- only by the owner via GET /api/v1/me/<provider>-token. `secret_ciphertext` is the AES-256-GCM
-- blob (lib/secrets/crypto.ts); `meta` holds NON-secret context (slack_user_id, workspace, scopes).
create table if not exists member_secrets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  member_id uuid not null references members(id) on delete cascade,
  provider text not null,
  secret_ciphertext text not null,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (team_id, member_id, provider)
);
create index if not exists member_secrets_member_idx on member_secrets (member_id);
