-- Generated media (Social Brain): images produced for a content variant. Opt-in per variant and
-- rate-capped (10/team/day, lib/media/generate-image) since image generation costs real money.
-- The image bytes live inline as base64 for V1 (low volume behind the cap); object storage is a
-- later swap. Single writer: lib/media/store.ts. Tier inherited from the variant (no RLS backstop).
--
-- Mirrors postgres/schema.sql (from-zero load). Idempotent: safe to replay.

create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  variant_id uuid not null references content_variants(id) on delete cascade,
  access access_tier not null,               -- inherited from the variant
  kind text not null default 'image' check (kind in ('image')),
  provider text not null,                    -- e.g. 'openai'
  model text not null,                       -- e.g. 'gpt-image-1.5'
  prompt text not null default '',
  data_base64 text not null,                 -- the image bytes (base64); V1 inline storage
  cost_usd numeric(10, 5) not null default 0,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists media_assets_variant_idx on media_assets (variant_id, created_at desc);
create index if not exists media_assets_team_day_idx on media_assets (team_id, created_at);
