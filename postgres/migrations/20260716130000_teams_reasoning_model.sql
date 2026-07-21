-- Two-model config: a team can set a distinct REASONING model (used for reasoning-heavy tasks like
-- narrative arc synthesis) alongside the default "query" model (the per-provider config.model / the
-- Active answering model). Nullable — when unset, reasoning-role tasks fall back to the query model.
alter table teams add column if not exists reasoning_model text;
