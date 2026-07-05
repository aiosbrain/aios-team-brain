-- Perf indexes (audit MEDIUM). Hot predicates that were seq-scanning:
--   items ordered by (team_id, synced_at desc) in retrieval + several dashboard reads (only a
--     (team_id, updated_at) index existed); code_contributions filtered by team_id in the
--     per-contributor activity digest (only member/codebase indexes existed).
create index if not exists items_team_synced_idx on items (team_id, synced_at desc);
create index if not exists code_contributions_team_idx on code_contributions (team_id);
