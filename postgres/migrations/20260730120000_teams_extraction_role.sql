-- A third model role: EXTRACTION — a distinct provider + model for high-volume machine extraction.
--
-- WHY. Graph extraction is 99% of the brain's LLM bill ($51.01 of $51.70 lifetime). The graph LLM proxy
-- made Admin the single source of truth for the graph's key, which was right, but it collapsed two
-- decisions into one: extraction inherited the ANSWERING model, and this team answers with a reasoning
-- model at $4.425/M output whose completion tokens were ~87% chain-of-thought on a mechanical,
-- schema-constrained transformation. A reasoning model is the right pick for answering and the wrong one
-- for extraction; these columns let a team have both.
--
-- Nullable, and null is the pre-existing behaviour: extraction resolves the answering backend exactly as
-- before, so every installed deployment is unchanged until an admin opts in. The MODEL is the activation
-- switch; a provider without a model leaves the role off.
--
-- `anthropic` is deliberately ABSENT from the CHECK. The only consumer is the graph proxy, and Graphiti
-- extracts via OpenAI structured outputs (`beta.chat.completions.parse`), which `graphChatTarget` refuses
-- to approximate for Anthropic — so allowing it here would let one dropdown make every extraction call
-- 501 while Graphiti keeps answering 202: a silently empty graph. Widening this list later (if the in-app
-- `complete.ts` callers adopt the role, where Anthropic works) is additive and safe; narrowing is the
-- direction that breaks a release (incident #251), so start narrow.
--
-- Consumed by lib/query/llm-backend.selectLlmBackend (role:"extraction"). Additive + idempotent.
alter table teams add column if not exists extraction_model text;
alter table teams add column if not exists extraction_provider text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_extraction_provider_check') then
    alter table teams add constraint teams_extraction_provider_check check (extraction_provider in ('openai', 'openrouter', 'local'));
  end if;
end $$;
