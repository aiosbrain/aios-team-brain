-- Arc stability (fact-set-hash skip): store a hash of the exact LLM synthesis input on arc_cache, so the
-- background refresh can skip the non-deterministic LLM re-synthesis when the facts are unchanged — arcs
-- then change only when the underlying work does, not every 10-min recompute. Nullable/additive; mirrored
-- into postgres/schema.sql. Pre-existing rows have null until their next recompute (which establishes it).
alter table arc_cache add column if not exists facts_hash text;
