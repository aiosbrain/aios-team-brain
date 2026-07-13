-- Brand Brain (Social Brain M1): one persistent per-team brand config — voice, company
-- knowledge, and governance — that later milestones validate generated content against before
-- approval/publication. One row per team (team_id is the PK). Non-secret config only (no
-- credentials here — those stay in `integrations`). Single writer: lib/brand/manage.ts.
--
-- Mirrors postgres/schema.sql (from-zero load). Idempotent: safe to replay. No RLS — admin/team
-- scoping is app-code (the whole /admin area is admin-gated).

create table if not exists brand_profiles (
  team_id uuid primary key references teams(id) on delete cascade,
  voice jsonb not null default '{}',        -- vocabulary, tone, formatting, preferred/prohibited phrases
  knowledge jsonb not null default '{}',    -- products, positioning, audiences, claims, roadmap visibility
  governance jsonb not null default '{}',   -- confidential topics, legal/pricing/disclosure rules, approval thresholds
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
