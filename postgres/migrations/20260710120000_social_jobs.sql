-- Social Brain durable job/outbox (M0). The brain has no job queue: async work is either
-- synchronous, best-effort `after()`, or in-process interval pollers that re-scan a durable
-- source. The Social Brain needs work that survives a redeploy and retries on failure
-- (multi-minute media renders, provider polling, scheduled publishing, publish/analytics
-- retries). This is the smallest durable primitive that unblocks those: one row per unit of
-- work, claimed by the in-process poller, retried with backoff, dead-lettered on exhaustion.
--
-- Mirrors postgres/schema.sql (from-zero load). Idempotent: safe to replay. Single writer:
-- lib/jobs/store.ts. No RLS — team scoping is app-code (like every other table).

do $$ begin
  create type social_job_status as enum ('queued', 'running', 'done', 'dead');
exception when duplicate_object then null; end $$;

create table if not exists social_jobs (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  kind text not null,                         -- 'generate_image' | 'poll_render' | 'publish' | 'collect_analytics' | …
  payload jsonb not null default '{}',        -- kind-specific input (no secrets — those stay in integrations)
  status social_job_status not null default 'queued',
  attempts integer not null default 0,        -- times a worker has started this job
  max_attempts integer not null default 5,    -- after this many failed attempts → 'dead'
  run_after timestamptz not null default now(), -- earliest eligible run time (scheduling + backoff)
  locked_at timestamptz,                       -- when the current worker claimed it (null unless running)
  last_error text,                             -- most recent failure message (surfaced, never thrown)
  dedup_key text,                              -- optional idempotency key; unique per team when set
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Claim scan: the poller selects queued rows whose run_after is due, oldest first.
create index if not exists social_jobs_due_idx on social_jobs (status, run_after);
create index if not exists social_jobs_team_idx on social_jobs (team_id, created_at desc);
-- Idempotent enqueue: a (team, dedup_key) pair maps to at most one job.
create unique index if not exists social_jobs_dedup_idx
  on social_jobs (team_id, dedup_key) where dedup_key is not null;
