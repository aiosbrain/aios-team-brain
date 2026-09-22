-- AIO-1167: Google Drive/Docs is a data connector type. `google` remains the Gemini
-- provider-key type; these values are intentionally distinct. Preserve retired legacy values
-- (`wise`, `granola`) so an existing self-host row cannot break an additive schema load.
alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check
  check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google','openrouter','typefully','notion','gdrive','clickup'));

-- Exact Google provider ids are authoritative; legacy normalized paths are only compatibility hints.
-- Keep mappings after an item purge so a restored document reuses its established UUID.
create table if not exists source_item_mappings (
  team_id uuid not null references teams(id) on delete cascade,
  source text not null,
  provider_id text not null,
  item_id uuid not null,
  connection_id text,
  project_id uuid references projects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (team_id, source, provider_id),
  unique (team_id, item_id)
);
create index if not exists source_item_mappings_connection_idx
  on source_item_mappings (team_id, source, connection_id);
