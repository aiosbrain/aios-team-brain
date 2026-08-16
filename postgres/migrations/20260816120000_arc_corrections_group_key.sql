-- PCCC6B-1: scope arc corrections to the SYNTHESIS SCOPE they were made in — the sorted
-- group-set key, the same scheme arc_cache.group_key uses — so a correction can never feed a
-- synthesis over a different scope (spec: cross-partition synthesis is never computed; the
-- laundering vector was corrections written under the team-global table feeding EVERY team-tier
-- synthesis). '' = legacy pre-6b row: tier-scope by construction (the recompute route has always
-- refused external principals), accepted ONLY by the tier-path synthesis, never a partition scope.
alter table arc_corrections add column if not exists group_key text not null default '';
create index if not exists arc_corrections_team_scope_idx on arc_corrections (team_id, group_key, updated_at desc);

-- Per-SCOPE correction identity (Fable 6b High 2): the team-global unique let one member's
-- correction silently MOVE another member's row across scopes (arc_id = sha(title); near-identical
-- scopes mint identical titles). New arbiter FIRST, then drop the old one — identically named here
-- and in schema.sql (the PCCC-3 round-2 Medium 7 lesson: an inline unique would auto-name
-- differently and give a from-zero DB two arbiters). Deploy-window note, named not hidden: the OLD
-- release's ON CONFLICT (team_id, arc_id) fails LOUDLY for the minutes between this migration and
-- the release flip — a rare, user-visible, retryable error on a human-paced write, accepted over a
-- second deploy for a constraint swap.
create unique index if not exists arc_corrections_scope_arc_key on arc_corrections (team_id, group_key, arc_id);
alter table arc_corrections drop constraint if exists arc_corrections_team_id_arc_id_key;
