-- W2.1 additive delta for the postgres target: daily token + cost totals on AEM snapshots.
-- `agentic_maturity_snapshots` already exists in prod, so the matching `create table if not
-- exists` in postgres/schema.sql is a no-op there — these columns only land via this ALTER.
-- Idempotent (add column if not exists); also mirrored into postgres/schema.sql for from-zero.
alter table agentic_maturity_snapshots
  add column if not exists total_cost_usd numeric(12, 5) not null default 0,
  add column if not exists input_tokens bigint not null default 0,
  add column if not exists output_tokens bigint not null default 0,
  add column if not exists cache_read_tokens bigint not null default 0;
