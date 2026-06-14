-- 0002 content: projects, items, item_versions
-- Synced corpus from contributor repos (contract: aios-workspace docs/brain-api.md).
-- pgvector is enabled and an embedding column reserved so semantic retrieval is a
-- backfill later, not a migration.

create extension if not exists vector;

create type item_kind as enum ('deliverable', 'transcript', 'decision', 'task', 'artifact');

create table projects (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  slug text not null,
  name text not null default '',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  unique (team_id, slug)
);

create table items (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  path text not null,
  kind item_kind not null,
  access access_tier not null,          -- 'admin' has no enum value: it cannot exist here
  frontmatter jsonb not null default '{}',
  body text not null default '',
  content_sha256 text not null,
  actor text not null default '',       -- pushed-by handle (provenance)
  member_id uuid references members(id) on delete set null,
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as
    (to_tsvector('english', coalesce(path, '') || ' ' || coalesce(body, ''))) stored,
  embedding vector(1024),               -- reserved for fast-follow backfill
  unique (team_id, project_id, path)
);
create index items_team_updated_idx on items (team_id, updated_at desc);
create index items_search_idx on items using gin (search);
create index items_kind_idx on items (team_id, kind);

create table item_versions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items(id) on delete cascade,
  content_sha256 text not null,
  frontmatter jsonb not null default '{}',
  body text not null default '',
  member_id uuid references members(id) on delete set null,
  created_at timestamptz not null default now()
);
create index item_versions_item_idx on item_versions (item_id, created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table projects enable row level security;
alter table items enable row level security;
alter table item_versions enable row level security;

create policy projects_select on projects for select
  to authenticated
  using (team_id in (select private.my_team_ids()));

-- Tier filtering: members with tier 'team' see everything; tier 'external'
-- members see only external items. (admin content never reaches the DB.)
create policy items_select on items for select
  to authenticated
  using (
    team_id in (select private.my_team_ids())
    and (private.my_tier(team_id) = 'team' or access = 'external')
  );

create policy item_versions_select on item_versions for select
  to authenticated
  using (
    exists (
      select 1 from items i
      where i.id = item_versions.item_id
        and i.team_id in (select private.my_team_ids())
        and (private.my_tier(i.team_id) = 'team' or i.access = 'external')
    )
  );

-- No INSERT/UPDATE/DELETE policies for authenticated: sync (service role via
-- the API key path) is the only write path for content.
