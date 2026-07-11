-- Publishing (Social Brain M5): Typefully as the first provider. Widen the integrations type
-- CHECK to allow a 'typefully' credential, add the per-team dry-run flag (safe default: no live
-- posts until flipped off), and add the publication ledger. Additive + idempotent. Mirrored into
-- schema.sql for from-zero. Single writers: lib/social/publications.ts, lib/social/settings.ts.

alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check
  check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google','openrouter','typefully'));

alter table social_settings add column if not exists publish_dry_run boolean not null default true;

create table if not exists social_publications (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  variant_id uuid not null references content_variants(id) on delete cascade,
  access access_tier not null,
  provider text not null default 'typefully',
  status text not null default 'scheduled'
    check (status in ('scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  dry_run boolean not null default true,
  scheduled_at timestamptz,
  published_at timestamptz,
  external_id text,
  external_url text,
  last_error text,
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists social_publications_team_idx on social_publications (team_id, created_at desc);
create index if not exists social_publications_variant_idx on social_publications (variant_id);
