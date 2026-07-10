-- Social Brain content domain (M2 foundation): the durable data model + lifecycle for turning a
-- discovered opportunity into platform-specific content variants. This migration lands the SCHEMA
-- only — the discovery-scoring and brand-aware planning ALGORITHMS are a later, product-steered
-- milestone. Three tables:
--   social_opportunities — a notable development worth communicating (provenance preserved)
--   content_plans        — a decision to publish an opportunity (objective/audience)
--   content_variants     — one platform/format rendering, carrying the publish lifecycle
-- Every row carries an `access` tier inherited from its source evidence, so tier isolation
-- (CLAUDE.md §5) propagates opportunity → plan → variant. No RLS — app-code enforced.
-- Single writer: lib/social/store.ts. Mirrors postgres/schema.sql; idempotent.

do $$ begin
  create type opportunity_status as enum ('discovered', 'evaluated', 'planned', 'rejected', 'expired');
exception when duplicate_object then null; end $$;
do $$ begin
  create type content_status as enum (
    'planned', 'generating', 'generated', 'validating', 'awaiting_approval', 'approved',
    'scheduled', 'publishing', 'published', 'analyzing', 'completed',
    'rejected', 'failed', 'cancelled', 'expired'
  );
exception when duplicate_object then null; end $$;

create table if not exists social_opportunities (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  access access_tier not null,              -- tier, inherited from the source evidence (isolation)
  source_type text not null,                -- 'manual' | 'item' | 'commit' | 'decision' | …
  title text not null,
  summary text not null default '',
  evidence jsonb not null default '[]',     -- [{item_id, path, note}] — provenance back to brain knowledge
  topics jsonb not null default '[]',
  audiences jsonb not null default '[]',
  novelty_score numeric(4, 3) not null default 0,     -- 0..1
  relevance_score numeric(4, 3) not null default 0,
  urgency_score numeric(4, 3) not null default 0,
  confidence_score numeric(4, 3) not null default 0,
  status opportunity_status not null default 'discovered',
  dedup_key text,                            -- idempotent discovery key; unique per team when set
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists social_opportunities_team_status_idx on social_opportunities (team_id, status, created_at desc);
create index if not exists social_opportunities_team_access_idx on social_opportunities (team_id, access);
create unique index if not exists social_opportunities_dedup_idx
  on social_opportunities (team_id, dedup_key) where dedup_key is not null;

create table if not exists content_plans (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  opportunity_id uuid not null references social_opportunities(id) on delete cascade,
  access access_tier not null,              -- inherited from the opportunity
  objective text not null default '',
  audience text not null default '',
  status text not null default 'planned' check (status in ('planned', 'active', 'archived')),
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_plans_team_opp_idx on content_plans (team_id, opportunity_id);
create index if not exists content_plans_team_access_idx on content_plans (team_id, access);

create table if not exists content_variants (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  plan_id uuid not null references content_plans(id) on delete cascade,
  access access_tier not null,              -- inherited from the plan
  platform text not null,                   -- 'x' | 'linkedin' | 'threads' | …
  format text not null,                     -- 'text' | 'image' | 'carousel' | …
  tone text not null default '',
  body text not null default '',
  status content_status not null default 'planned',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists content_variants_team_plan_idx on content_variants (team_id, plan_id);
create index if not exists content_variants_team_status_idx on content_variants (team_id, status);
