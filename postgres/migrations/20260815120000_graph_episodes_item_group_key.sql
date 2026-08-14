-- PCCC-3 (Deploy A of the two-deploy sequence — docs/design/phase-c-per-project-graphs.md §2.1):
-- widen the graph_episodes identity to per-(item, group). This index is the arbiter the projector's
-- new 4-column ON CONFLICT targets. The NARROW inline unique (team_id, source_table, source_id)
-- deliberately STAYS until Deploy B (PCCC-4): dropping it here would break the OLD release's
-- 3-column conflict target during the preDeploy→release window, silently (its upsert errors were
-- discarded until this slice). Identically named here and in schema.sql — an inline `unique (…)`
-- mirror would auto-name differently and give a from-zero DB two arbiter indexes.
create unique index if not exists graph_episodes_item_group_key
  on graph_episodes (team_id, source_table, source_id, group_id);
