-- Two-model config, part 2: a distinct PROVIDER for the reasoning model. Previously reasoning ran on
-- whatever provider answered (reasoning_model swapped the model but not the backend). This lets Admin
-- pick provider + model INDEPENDENTLY for the reasoning role (e.g. answer on OpenAI, reason on
-- OpenRouter). Nullable — when unset, reasoning reuses the answering provider (unchanged behavior).
-- Consumed by lib/query/llm-backend.selectLlmBackend (role:"reasoning"). Additive + idempotent.
alter table teams add column if not exists reasoning_provider text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_reasoning_provider_check') then
    alter table teams add constraint teams_reasoning_provider_check check (reasoning_provider in ('anthropic', 'openai', 'openrouter', 'local'));
  end if;
end $$;
