-- Allow 'openrouter' as an integration type (an OpenAI-compatible LLM gateway, per-team key + model).
-- The `type` CHECK constraint on `integrations` predates it, so a from-zero schema.sql edit is a
-- no-op on an existing prod DB — this migration widens the constraint in place. Idempotent.
--
-- REPLAY-SAFETY: pg:schema replays every migration on every deploy. This re-add must allow the SAME
-- complete set as schema.sql and every later migration, so a replay after a newer type exists in
-- prod can't reject a live row (the 2026-07-13 incident). 'typefully' (added by a later migration)
-- is intentionally listed here; the replay-consistency guard fails the build if these drift apart.
alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check
  check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google','openrouter','typefully'));
