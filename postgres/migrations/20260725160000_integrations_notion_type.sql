-- Add 'notion' to integrations.type so Notion credentials can be stored from Admin → Integrations.
-- The Notion CONNECTOR already exists (ingestion/aios_ingest/sources/notion.py, with author enrichment
-- via notion_authors.py); it just had nowhere to read a team's token from.
--
-- ⚠️ #251 replay rule: `npm run pg:schema` replays every migration in filename order on each deploy, so a
-- CHECK re-add must carry the FULL value set — a narrower re-add fails against live rows. Keep this list
-- identical to the one in postgres/schema.sql and to any later re-add
-- (guarded by test/guards/enum-check-replay.test.ts).
alter table integrations drop constraint if exists integrations_type_check;
alter table integrations add constraint integrations_type_check
  check (type in ('github','granola','slack','wise','linear','plane','openai','anthropic','google','openrouter','typefully','notion'));
