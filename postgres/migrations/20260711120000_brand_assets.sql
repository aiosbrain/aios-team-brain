-- Brand assets (Social Brain): a per-team library of reference material the Brand Brain layers
-- into generation — website/URLs, logo/image asset links, and reference examples to emulate. A
-- one-to-many companion to `brand_profiles` (which holds the voice/knowledge/governance config).
-- Non-secret (public URLs + notes); credentials never live here. Single writer: lib/brand/assets.ts.
--
-- Mirrors postgres/schema.sql (from-zero load). Idempotent: safe to replay. No RLS — the /admin
-- area is admin-gated in app code.

create table if not exists brand_assets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  kind text not null check (kind in ('url', 'asset', 'reference')),
  label text not null,
  url text,                                  -- required for kind url/asset; optional for reference
  notes text not null default '',
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists brand_assets_team_idx on brand_assets (team_id, created_at desc);
