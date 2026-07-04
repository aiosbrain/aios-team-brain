-- ───────────────────────────────────────────────────────────────────────────
-- OPTIONAL: dense (semantic) passage retrieval via pgvector.
--
-- This is NOT part of the default schema (`postgres/schema.sql`), which stays
-- extension-free so the brain runs on stock Postgres. Load this ONLY if you want
-- semantic retrieval, and only against a Postgres that has the `vector` extension
-- available (Railway or the `pgvector/pgvector` image):
--
--     DATABASE_URL=… npm run pg:schema:vector      # after `npm run pg:schema`
--
-- Then set EMBEDDINGS_URL (see docs/PROVIDERS.md) to turn dense retrieval ON. With
-- the table absent OR EMBEDDINGS_URL unset, the native provider silently falls back
-- to keyword FTS + Graphiti — nothing breaks. Idempotent; safe to re-run.
--
-- Vector dimension defaults to 1536 (OpenAI text-embedding-3-small / -ada-002). If
-- you use a model with a different dimension, change the `vector(1536)` below to match
-- BEFORE first load and set EMBEDDINGS_DIM accordingly.
-- ───────────────────────────────────────────────────────────────────────────

create extension if not exists vector;

-- One row per (item, chunk). `access` mirrors items.access so dense hits can be tier-filtered in
-- the same app-code path as FTS (no RLS backstop on postgres — CLAUDE.md §5). `content_sha256` is
-- the hash of the SOURCE item body the chunks were derived from, so the indexer can skip unchanged
-- items and replace an item's chunk set atomically on change.
create table if not exists item_chunks (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  chunk_idx int not null,
  content text not null,
  access access_tier not null default 'team',
  content_sha256 text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  unique (item_id, chunk_idx)
);
create index if not exists item_chunks_item_idx on item_chunks (item_id);
create index if not exists item_chunks_team_idx on item_chunks (team_id);
-- HNSW ANN index for cosine distance (`<=>`). Cosine matches normalized embeddings from most APIs.
create index if not exists item_chunks_embedding_idx
  on item_chunks using hnsw (embedding vector_cosine_ops);
