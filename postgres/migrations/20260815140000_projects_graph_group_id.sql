-- PCCC-4 (Deploy B, part 1 — docs/design/phase-c-per-project-graphs.md §2.4 step 2; spec-ruled at
-- docs/specs/project-context-classification-v1.md ~946-950): every project stores its Graphiti
-- partition pointer. Graphiti has no rename operation, so nothing is renamed and nothing is
-- re-extracted: the §11 built-ins GRANDFATHER the legacy tier group ids (General ->
-- '<teamSlug>_team', external-shared -> '<teamSlug>_external') — the existing graphs become those
-- projects' partitions BY POINTER — and every other project mints the PCCC-1 scheme
-- 'g_<teamId-hex>_p_<projectId-hex>'. Stored, not inferred: readers resolve THIS column, never
-- recompute (lib/graph/group.projectGroupId is the mint default only).
--
-- Replay-safe by construction: the column add is IF NOT EXISTS, every backfill is guarded on
-- `graph_group_id is null` (a replay never re-mints), and the index is IF NOT EXISTS.
alter table projects add column if not exists graph_group_id text;

-- Grandfathered built-ins FIRST (the catch-all below must not mint over them). The
-- `not exists` term is the FOREIGN-HISTORY refusal (PCCC-4 code review, Codex High 1): a team
-- that renamed away BEFORE this backfill left its historical episodes under the old slug's
-- group; a new team holding that slug must NOT silently inherit them — its built-in stays
-- unpointed here, and the pointer writer's own foreign-history check then refuses LOUDLY with
-- the named repair at the next bootstrap.
update projects p
   set graph_group_id = t.slug || '_team'
  from teams t
 where p.team_id = t.id
   and p.kind = 'system'
   and p.slug = 'general'
   and p.graph_group_id is null
   and not exists (
     select 1 from graph_episodes ge
      where ge.group_id = t.slug || '_team' and ge.team_id <> p.team_id
   );

update projects p
   set graph_group_id = t.slug || '_external'
  from teams t
 where p.team_id = t.id
   and p.kind = 'system'
   and p.slug = 'external-shared'
   and p.graph_group_id is null
   and not exists (
     select 1 from graph_episodes ge
      where ge.group_id = t.slug || '_external' and ge.team_id <> p.team_id
   );

-- Everything else mints the per-project scheme (hyphen-stripped UUIDs, charset-safe by
-- construction — mirrors lib/graph/group.projectGroupId exactly). Built-ins are EXCLUDED, not
-- just already-pointed: one skipped above by the foreign-history refusal must stay NULL so the
-- pointer writer refuses loudly at bootstrap — minting it here would hand General an empty
-- partition, the design's §2.0 silently-empty failure.
update projects
   set graph_group_id = 'g_' || replace(team_id::text, '-', '') || '_p_' || replace(id::text, '-', '')
 where graph_group_id is null
   and not (kind = 'system' and slug in ('general', 'external-shared'));

-- Two projects may never share a partition: injective by CONSTRAINT, not convention. Partial so a
-- not-yet-pointed row (the insert-then-point window at creation) doesn't collide on null.
create unique index if not exists projects_graph_group_id_key
  on projects (graph_group_id) where graph_group_id is not null;
