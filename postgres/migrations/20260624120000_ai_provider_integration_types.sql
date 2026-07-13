-- Allow LLM provider API keys to be stored as integrations: add 'openai', 'anthropic', 'google'
-- to integrations.type. The key itself goes in the encrypted secret_ciphertext column (same path
-- as Slack/Plane); config stays empty for these types. Idempotent: drop + recreate the inline
-- check (Postgres auto-names it integrations_type_check) with the widened value set.
--
-- REPLAY-SAFETY: pg:schema replays every migration on every deploy (no applied-tracking). This
-- re-add must therefore allow the SAME complete set as schema.sql and every later migration —
-- otherwise, replayed after a newer type ('openrouter'/'typefully') exists in prod, this narrower
-- CHECK would reject a live row and abort the deploy (the 2026-07-13 incident). 'openrouter' and
-- 'typefully' are intentionally listed here even though they were introduced by later migrations;
-- test/guards/integrations-type-check-replay.test.ts fails the build if these ever drift apart.
alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check
  check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google','openrouter','typefully'));
