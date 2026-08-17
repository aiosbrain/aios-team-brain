-- PRET-3 H2 (docs/design/pret3-arcs-unification.md §1a): every arcs read becomes g:-exact after
-- the unification, so TIER-SET-keyed correction rows (a permissive team's whole correction
-- history; any enforcing team's pre-PPARC rows the retiring includeLegacy arm still served)
-- would silently stop feeding synthesis — the H13 revert, fleet-wide. Re-key them to the
-- General built-in's partition key (single target: the external-shared partition is
-- corrections-free by the H1 rule, so duplicating there would feed nothing).
--
-- Shape notes:
--   * The tier-set key is the sorted tier-group join — always contains ','-free group ids and
--     is NOT g:-prefixed and NOT '' (pre-6b legacy rows keep their PPARC-3 disposition: kept,
--     unread, counted by the slice's criterion-4 query).
--   * The target key comes from the STORED General pointer (rename doctrine — a slug-derived
--     id would disjoin from the graph for renamed teams).
--   * Idempotent: re-keyed rows are g:-prefixed and stop matching. Replay-safe.
--   * The per-scope unique (team_id, group_key, arc_id) can collide when a g:-keyed correction
--     for the same arc already exists (a member re-corrected post-cutover): the EXISTING g: row
--     wins (it is newer by construction) and the tier row is left in place, unread — same
--     kept-not-deleted posture as '' rows; the deploy log reports the count via the NOTICE.
do $$
declare
  moved int;
  kept int;
begin
  update arc_corrections ac
     set group_key = 'g:' || p.graph_group_id
    from teams t
    join projects p on p.team_id = t.id and p.kind = 'system' and p.slug = 'general'
   where t.id = ac.team_id
     and p.graph_group_id is not null
     and ac.group_key <> ''
     and ac.group_key not like 'g:%'
     and not exists (
       select 1 from arc_corrections dup
        where dup.team_id = ac.team_id
          and dup.group_key = 'g:' || p.graph_group_id
          and dup.arc_id = ac.arc_id
     );
  get diagnostics moved = row_count;
  select count(*) into kept from arc_corrections
   where group_key <> '' and group_key not like 'g:%';
  raise notice 'arc_corrections tier re-key: % moved, % kept unread (post-cutover g: row already exists)', moved, kept;
end $$;
