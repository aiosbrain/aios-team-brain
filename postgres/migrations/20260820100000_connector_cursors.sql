-- TICKFIT-1: per-repo remote sync watermarks (docs/design/tickfit1-github-watermark.md D1).
-- A tiny keyed store for connector cursors — the remote's OWN values (pushed_at etc.), compared
-- by equality, so a quiet tick can prove a repo unchanged without re-scanning it. New table, so
-- schema.sql's create-if-not-exists covers from-zero; this migration covers the live fleet.
create table if not exists connector_cursors (
  team_id uuid not null references teams(id) on delete cascade,
  key text not null,
  cursor jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (team_id, key)
);
