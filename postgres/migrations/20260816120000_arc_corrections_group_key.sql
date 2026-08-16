-- PCCC6B-1: scope arc corrections to the SYNTHESIS SCOPE they were made in — the sorted
-- group-set key, the same scheme arc_cache.group_key uses — so a correction can never feed a
-- synthesis over a different scope (spec: cross-partition synthesis is never computed; the
-- laundering vector was corrections written under the team-global table feeding EVERY team-tier
-- synthesis). '' = legacy pre-6b row: tier-scope by construction (the recompute route has always
-- refused external principals), accepted ONLY by the tier-path synthesis, never a partition scope.
alter table arc_corrections add column if not exists group_key text not null default '';
create index if not exists arc_corrections_team_scope_idx on arc_corrections (team_id, group_key, updated_at desc);
