-- Meeting Notes feature: rich metadata layer over a normal ingested `items` row (kind='transcript'),
-- so a meeting note is fully searchable/queryable through the existing FTS/retrieve pipeline for
-- free. New tables need no migration on their own (create table if not exists in schema.sql covers
-- a from-zero load) — this file exists ONLY for the additive column on the pre-existing
-- `member_profiles` table, which `schema.sql`'s `create table if not exists` cannot express on an
-- already-deployed DB. See postgres/migrations/README.md.
alter table member_profiles add column if not exists avatar_data_url text;
