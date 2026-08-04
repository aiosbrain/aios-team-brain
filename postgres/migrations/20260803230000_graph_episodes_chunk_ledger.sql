-- GRAPHCOST-1 (AIO-735) — per-chunk projection ledger.
--
-- `content_sha256` hashes the WHOLE item body, so any byte changing anywhere re-pushes every one of
-- the item's chunk episodes to Graphiti for LLM extraction — even when the change lands past the
-- extraction cap (CHUNK_CHARS * MAX_EPISODE_CHUNKS) and the extracted content is byte-identical.
-- Measured on prod: 5 of the 7 most recent docs/ARCHITECTURE.md edits were entirely beyond the cap,
-- each re-pushing 16 episodes of unchanged text.
--
-- `chunk_shas` records the per-chunk hashes of the content last pushed to `group_id`, so the next
-- pass can push only what actually changed. `chunk_config` records the chunk sizing those hashes
-- were produced under: `content_sha256` is invariant to chunking, so without it a raised
-- GRAPH_MAX_EPISODE_CHUNKS would leave the early chunks hashing identically while the new tail
-- chunks had never been pushed — and the ledger would report them as already extracted.
--
-- Both default to the empty value, which reads as "no per-chunk knowledge" and makes every existing
-- row take the full-push path until a pass records it. See lib/graph/project.ts.
alter table graph_episodes add column if not exists chunk_shas text[] not null default '{}';
alter table graph_episodes add column if not exists chunk_config text not null default '';
