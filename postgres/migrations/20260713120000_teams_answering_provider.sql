-- Explicit answering-backend override for the Query box (Admin → Integrations "Active answering
-- model" selector, setAnsweringProvider). Null = auto precedence (OpenRouter → LLM_BASE_URL →
-- Anthropic, unchanged default); a set value forces that backend in lib/query/llm-backend. Each
-- backend's model is the provider integration's config.model (openrouter already; anthropic/openai
-- added), so "which model we're actually using" is fully admin-controllable. Additive + idempotent.
alter table teams add column if not exists answering_provider text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_answering_provider_check') then
    alter table teams add constraint teams_answering_provider_check check (answering_provider in ('anthropic', 'openai', 'openrouter', 'local'));
  end if;
end $$;
