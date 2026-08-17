-- PRET-3 H2 (docs/design/pret3-arcs-unification.md §1a): every arcs read becomes g:-exact after
-- the unification, so TIER-SET-keyed correction rows (a permissive team's whole correction
-- history; any enforcing team's pre-PPARC rows the retiring includeLegacy arm still served)
-- would silently stop feeding synthesis — the H13 revert, fleet-wide. Re-key them to the
-- General built-in's partition key (single target: the external-shared partition is
-- corrections-free by the H1 rule, so duplicating there would feed nothing).
--
-- Shape notes (diff-review H1/H2 — the fleet holds shapes the first draft did not model):
--   * ELIGIBLE = not '' (pre-6b legacy rows keep their PPARC-3 kept-unread disposition), not
--     'g:%' (already partition-keyed), and NOT 'p:%' — the PPARC-3 migration deliberately KEPT
--     multi-group p: rows unread ("cannot be attributed to one partition; human data is never
--     deleted"); re-keying a union-derived correction into the Everyone-visible General
--     synthesis is the §2.4 laundering shape. That ruling stands.
--   * ONE row per (team, arc_id) is re-keyed — the NEWEST eligible one (updated_at, id desc) —
--     because two eligible siblings (pre-/post-rename tier keys; renameTeam exists) mapping to
--     one target in a single UPDATE would violate the per-scope unique and HALT the deploy
--     from preDeploy (the migration-replay incident class). Losers stay kept-unread, counted.
--   * An EXISTING g: row for the same (team, arc_id) wins and the eligible row stays
--     kept-unread — not because it is provably newer (a post-downgrade permissive
--     re-correction can be newer), but because overwriting a live g: correction from a
--     retired-scope row risks reverting a current edit; the stranded newer edit is
--     recoverable human data, counted below.
--   * The target key comes from the STORED General pointer (rename doctrine — a slug-derived
--     id would disjoin from the graph for renamed teams). Teams with no General pointer are
--     skipped and counted separately.
--   * Idempotent: re-keyed rows are g:-prefixed and stop matching. Replay-safe.
do $$
declare
  moved int;
  kept_conflict int;
  kept_p int;
  skipped_no_pointer int;
begin
  with eligible as (
    select distinct on (ac.team_id, ac.arc_id)
           ac.id, ac.team_id, ac.arc_id, p.graph_group_id
      from arc_corrections ac
      join teams t on t.id = ac.team_id
      join projects p on p.team_id = t.id and p.kind = 'system' and p.slug = 'general'
     where p.graph_group_id is not null
       and ac.group_key <> ''
       and ac.group_key not like 'g:%'
       and ac.group_key not like 'p:%'
     order by ac.team_id, ac.arc_id, ac.updated_at desc, ac.id desc
  )
  update arc_corrections ac
     set group_key = 'g:' || e.graph_group_id
    from eligible e
   where ac.id = e.id
     and not exists (
       select 1 from arc_corrections dup
        where dup.team_id = e.team_id
          and dup.group_key = 'g:' || e.graph_group_id
          and dup.arc_id = e.arc_id
     );
  get diagnostics moved = row_count;
  select count(*) into kept_p from arc_corrections where group_key like 'p:%';
  select count(*) into skipped_no_pointer from arc_corrections ac
   where ac.group_key <> '' and ac.group_key not like 'g:%' and ac.group_key not like 'p:%'
     and not exists (
       select 1 from projects p
        where p.team_id = ac.team_id and p.kind = 'system' and p.slug = 'general'
          and p.graph_group_id is not null);
  select count(*) into kept_conflict from arc_corrections ac
   where ac.group_key <> '' and ac.group_key not like 'g:%' and ac.group_key not like 'p:%'
     and exists (
       select 1 from projects p
        where p.team_id = ac.team_id and p.kind = 'system' and p.slug = 'general'
          and p.graph_group_id is not null);
  raise notice 'arc_corrections tier re-key: % moved; % kept (a g: row or a newer sibling holds the slot); % kept p:-multigroup (PPARC-3 ruling); % skipped (no General pointer)',
    moved, kept_conflict, kept_p, skipped_no_pointer;
end $$;

-- Diff-review M1 + the Codex rollout-race finding (H1): the pre-H1 external-row wipe does NOT
-- live here. This file runs as Railway's preDeployCommand while the OLD application is still
-- serving — old code writes corrections-influenced external rows during the deploy window, and
-- a migration-stamped marker would bless exactly those rows forever ("corrections-free by
-- construction" is false until the new code is live). The wipe (and a catch-up re-key sweep
-- for corrections written in the same window) runs in the NEW application's boot path instead
-- (lib/graph/pret3-boot-sweep.ts — marker-guarded via migration_markers, stamped only AFTER
-- new-code activation, idempotent, multi-replica safe). The re-key above still runs here for
-- the bulk: it is idempotent and replayed every deploy, so pre-existing rows convert as early
-- as possible; the boot sweep owns the deploy-window stragglers.
