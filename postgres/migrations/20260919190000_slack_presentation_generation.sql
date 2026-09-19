-- AIO-1170: independent revision for committed Slack title/author presentation changes.
-- Additive and safe to replay on both pre-activation and already upgraded databases.
alter table slack_team_state add column if not exists presentation_generation
  bigint not null default 0 check (presentation_generation >= 0);
