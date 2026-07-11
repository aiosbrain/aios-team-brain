-- Social Brain slice 3: generated post images + per-team daily image cap.
-- Additive + idempotent (mirrors postgres/schema.sql for from-zero). Applied after schema.sql.

alter table teams add column if not exists social_image_daily_cap int not null default 10;

create table if not exists content_images (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  variant_id uuid not null references content_variants(id) on delete cascade,
  access access_tier not null,
  mime text not null default 'image/png',
  data_base64 text not null,
  prompt text not null default '',
  created_at timestamptz not null default now(),
  unique (variant_id)
);
create index if not exists content_images_team_created_idx on content_images (team_id, created_at desc);
