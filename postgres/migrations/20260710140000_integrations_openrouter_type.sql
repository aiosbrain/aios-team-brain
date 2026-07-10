-- Allow 'openrouter' as an integration type (an OpenAI-compatible LLM gateway, per-team key + model).
-- The `type` CHECK constraint on `integrations` predates it, so a from-zero schema.sql edit is a
-- no-op on an existing prod DB — this migration widens the constraint in place. Idempotent.
alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check
  check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google','openrouter'));
