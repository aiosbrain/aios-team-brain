-- Work-timeline context layer: task work-signal timestamps.
-- Both nullable, additive, safe to replay. Mirrored into postgres/schema.sql (create-table body +
-- the additive alter block) for from-zero.
--
--   worked_at   = the provider's last state-transition time (Linear startedAt/completedAt/canceledAt;
--                 falls back to updatedAt). The timeline's "did work" signal — distinct from the
--                 edit-time updated_at, which bumps on any relabel and used to resurface dormant tickets.
--   assigned_at = when the assignee last CHANGED (stamped by lib/ingest materializeTasks only on a real
--                 assignee change). Powers the timeline "newly assigned" bucket.
alter table tasks add column if not exists worked_at timestamptz;
alter table tasks add column if not exists assigned_at timestamptz;
