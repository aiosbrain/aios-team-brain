-- Additive: daily token + cost totals on AEM snapshots (from analyze --push signals).
alter table agentic_maturity_snapshots
  add column if not exists total_cost_usd numeric(12, 5) not null default 0,
  add column if not exists input_tokens bigint not null default 0,
  add column if not exists output_tokens bigint not null default 0,
  add column if not exists cache_read_tokens bigint not null default 0;
