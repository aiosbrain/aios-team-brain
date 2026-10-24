-- AIO-1170 inactive durable hydration staging.  Safe to replay and deliberately creates no worker.
create table if not exists slack_thread_snapshots (
  team_id uuid not null references teams(id) on delete cascade,
  workspace_id text not null check (workspace_id ~ '^[A-Za-z0-9]+$'),
  channel_id text not null check (channel_id ~ '^[A-Za-z0-9]+$'),
  root_ts text not null check (root_ts ~ '^[0-9]+[.][0-9]{1,6}$'),
  snapshot_generation bigint not null check (snapshot_generation >= 0),
  messages jsonb not null check (jsonb_typeof(messages) = 'array'),
  stored_bytes integer not null check (stored_bytes >= 0 and stored_bytes <= 1048576),
  seen_cursors jsonb not null default '[]'::jsonb check (jsonb_typeof(seen_cursors) = 'array' and jsonb_array_length(seen_cursors) <= 1000),
  expires_at timestamptz not null,
  complete boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (team_id, workspace_id, channel_id, root_ts),
  foreign key (team_id, workspace_id, channel_id, root_ts)
    references slack_sync_threads(team_id, workspace_id, channel_id, root_ts) on delete cascade
);
create index if not exists slack_thread_snapshots_expiry_idx on slack_thread_snapshots (expires_at);
alter table slack_thread_snapshots add column if not exists seen_cursors jsonb not null default '[]'::jsonb;
alter table slack_thread_snapshots drop constraint if exists slack_thread_snapshots_actual_bytes_check;
alter table slack_thread_snapshots add constraint slack_thread_snapshots_actual_bytes_check
  check (stored_bytes = octet_length(messages::text) and octet_length(messages::text) <= 1048576);
alter table slack_thread_snapshots drop constraint if exists slack_thread_snapshots_cursor_history_check;
alter table slack_thread_snapshots add constraint slack_thread_snapshots_cursor_history_check
  check (jsonb_typeof(seen_cursors) = 'array' and jsonb_array_length(seen_cursors) <= 1000 and octet_length(seen_cursors::text) <= 1048576);
