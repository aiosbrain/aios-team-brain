-- Full-text search over chat message bodies, so the /query sidebar search can match conversation
-- CONTENT (not just titles). Generated tsvector column + GIN index, mirroring items.search.
alter table chat_messages add column if not exists search tsvector
  generated always as (to_tsvector('english', coalesce(content, ''))) stored;
create index if not exists chat_messages_search_idx on chat_messages using gin (search);
