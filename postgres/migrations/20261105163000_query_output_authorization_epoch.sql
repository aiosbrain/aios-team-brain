-- AIO-1167 R76 (F2/F3): durable query-output authorization provenance.
--
-- Every new answer-run, chat message and query-log row records the context authorization it was
-- produced under, so a durable reader can refuse Google-derived output after a revocation on its own,
-- independently of whether the worker that wrote it is still alive:
--   NULL      historical row written before this contract — completed messages/previews stay readable;
--             a NULL streaming partial is never replayed.
--   0         new output positively classified as having no Google-derived model input.
--   positive  the ORIGINAL ContextAuthorization epoch captured before the authorization/content reads;
--             source-bearing fields are readable only while the team's revocation epoch still equals it.
-- New writers always write 0 or the original positive epoch (never NULL). Additive and idempotent: no
-- backfill, no index, no foreign key, no destructive cleanup.

alter table chat_turn_runs add column if not exists context_authorization_epoch bigint;
alter table chat_messages add column if not exists context_authorization_epoch bigint;
alter table query_log add column if not exists context_authorization_epoch bigint;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_turn_runs_context_authorization_epoch_check') then
    alter table chat_turn_runs add constraint chat_turn_runs_context_authorization_epoch_check
      check (context_authorization_epoch is null or context_authorization_epoch >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_context_authorization_epoch_check') then
    alter table chat_messages add constraint chat_messages_context_authorization_epoch_check
      check (context_authorization_epoch is null or context_authorization_epoch >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'query_log_context_authorization_epoch_check') then
    alter table query_log add constraint query_log_context_authorization_epoch_check
      check (context_authorization_epoch is null or context_authorization_epoch >= 0);
  end if;
end $$;
