-- AIO-1170: additive suppression substrate. Existing mappings remain untouched; the
-- attended raw-to-qualified identity cutover is a separate, coordinated migration.
create table if not exists member_identity_suppressions (
  team_id uuid not null references teams(id) on delete cascade,
  provider text not null,
  external_id text not null,
  created_at timestamptz not null default now(),
  primary key (team_id, provider, external_id)
);
