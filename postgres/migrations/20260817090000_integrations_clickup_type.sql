-- Add 'clickup' to integrations.type so a ClickUp API token can be stored from Admin → Integrations.
-- The ClickUp READ CLIENT and normalizers already exist (lib/ingest/sources/clickup.ts +
-- clickup-normalize.ts, AIO-819); `clickup` was simply absent from INTEGRATION_TYPES, so
-- `integrationInputSchema`'s `z.enum(INTEGRATION_TYPES)` rejected the row and there was nowhere
-- to put the token — a connector that existed and could not be connected.
--
-- ⚠️ #251 replay rule: `npm run pg:schema` replays every migration in filename order on each deploy, so a
-- CHECK re-add must carry the FULL value set — a narrower re-add fails against live rows. Keep this list
-- identical to the one in postgres/schema.sql and to every other re-add
-- (guarded by test/guards/integrations-type-check-replay.test.ts + test/guards/enum-check-replay.test.ts).
alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check
  check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google','openrouter','typefully','notion','clickup'));
