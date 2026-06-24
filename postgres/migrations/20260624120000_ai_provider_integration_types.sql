-- Allow LLM provider API keys to be stored as integrations: add 'openai', 'anthropic', 'google'
-- to integrations.type. The key itself goes in the encrypted secret_ciphertext column (same path
-- as Slack/Plane); config stays empty for these types. Idempotent: drop + recreate the inline
-- check (Postgres auto-names it integrations_type_check) with the widened value set.
alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check
  check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google'));
