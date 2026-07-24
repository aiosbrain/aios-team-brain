-- Per-team embeddings-backend override for the semantic index (Admin "Embeddings model" picker).
-- Null = auto (env EMBEDDINGS_URL for self-host, else dense off). Constrained to the providers that
-- serve a 1536-dim OpenAI-compatible /embeddings model matching item_chunks.embedding vector(1536)
-- — openai/openrouter only. Mirrors teams.answering_provider / reasoning_provider.
alter table teams add column if not exists embedding_provider text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_embedding_provider_check') then
    alter table teams add constraint teams_embedding_provider_check check (embedding_provider in ('openai', 'openrouter'));
  end if;
end $$;
