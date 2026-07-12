-- Analytics (Social Brain M6): normalized per-publication metrics. One row per publication
-- (upserted in place — latest snapshot), a common metric subset in columns + the provider's raw
-- payload in `raw`. Typefully exposes X-only analytics, so LinkedIn/etc stay null for now. Single
-- writer: lib/social/analytics.ts. Tier inherited from the publication. Additive + idempotent;
-- mirrored into schema.sql for from-zero.

create table if not exists publication_analytics (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  publication_id uuid not null unique references social_publications(id) on delete cascade,
  access access_tier not null,
  provider text not null default 'typefully',
  impressions integer,
  likes integer,
  comments integer,
  shares integer,
  saves integer,
  clicks integer,
  raw jsonb not null default '{}',
  collected_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists publication_analytics_team_idx on publication_analytics (team_id, collected_at desc);
