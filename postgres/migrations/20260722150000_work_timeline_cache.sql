-- Work-timeline context layer (PR-B): persist the day → person → work ledger so the dashboard, the
-- CLI (GET /api/v1/timeline), and the LLM read it identically instead of recomputing per render.
-- Regenerable cache, never a source of truth — safe to truncate. `group_key` = the viewer tier
-- ('team' | 'external'); the (team_id, group_key) PK already scopes by team. Mirrored into
-- postgres/schema.sql (new table → create-if-not-exists there covers from-zero; this migration
-- covers existing deployments).
create table if not exists work_timeline_cache (
  team_id uuid not null references teams(id) on delete cascade,
  group_key text not null,
  payload jsonb not null default '[]'::jsonb,
  computed_at timestamptz not null default now(),
  primary key (team_id, group_key)
);
