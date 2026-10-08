-- Populated-replay fixture for `scripts/migrate-from-existing.mjs` (AIO-1167).
--
-- Rows that use a value only the WIDENED enumerated CHECKs admit, plus the minimum they hang off:
-- an `integrations.type = 'gdrive'` row and a `project_context_memberships.method = 'gdrive_claim'`
-- row. The migration lane inserts them into a scratch database, then replays the whole deploy over
-- them — which is what every later release does to a database that has started using those
-- values — and finally runs each shipped migration RAW to prove these rows would have refused it.
--
-- The same rows are the three shapes a Google Drive document's context can have when a deploy is
-- replayed over it, with NO connection claim behind any of them (the state a sanitized staging
-- restore produces, because the claim tables are not exported):
--   · claimed  — an active unit placed by the claim-authorized entry (`gdrive_claim`). Must survive.
--   · legacy   — an active unit with only a generic membership, from before claims existed. Must be
--                suppressed: the replay fails legacy Drive visibility closed.
--   · pending  — a retracted unit (final claim retired, cleanup pending). Must stay retracted.
--
-- One statement, so it is atomic and needs no parameters. Run ONLY against a scratch database:
-- it bypasses the application's single writers by design (it is a fixture, and the rows describe a
-- constraint and a replay hazard, not documents anyone can read).
with team as (
  insert into teams (slug, name) values ('replay-proof', 'Replay proof') returning id
), integration as (
  insert into integrations (team_id, type, name)
  select id, 'gdrive', 'replay-proof' from team
  returning id
), project as (
  insert into projects (team_id, slug, name)
  select id, 'replay-proof', 'Replay proof' from team
  returning id, team_id
), item as (
  insert into items (team_id, project_id, path, kind, access, content_sha256, frontmatter)
  select team_id, id, 'replay/proof.md', 'deliverable'::item_kind, 'team'::access_tier, 'replay-proof',
         '{"source":"gdrive","source_id":"replay-proof"}'::jsonb
    from project
  returning id, team_id, project_id
), legacy_item as (
  insert into items (team_id, project_id, path, kind, access, content_sha256, frontmatter)
  select team_id, id, 'replay/legacy.md', 'deliverable'::item_kind, 'team'::access_tier, 'replay-legacy',
         '{"source":"gdrive","source_id":"replay-legacy"}'::jsonb
    from project
  returning id, team_id, project_id
), pending_item as (
  insert into items (team_id, project_id, path, kind, access, content_sha256, frontmatter)
  select team_id, id, 'replay/pending.md', 'deliverable'::item_kind, 'team'::access_tier, 'replay-pending',
         '{"source":"gdrive","source_id":"replay-pending"}'::jsonb
    from project
  returning id, team_id
), unit as (
  insert into project_context_units (team_id, source_item_id, unit_key, audience, content_sha256)
  select team_id, id, 'item', 'team'::access_tier, 'replay-proof' from item
  returning id, team_id
), legacy_unit as (
  insert into project_context_units (team_id, source_item_id, unit_key, audience, content_sha256)
  select team_id, id, 'item', 'team'::access_tier, 'replay-legacy' from legacy_item
  returning id, team_id
), pending_unit as (
  insert into project_context_units (team_id, source_item_id, unit_key, audience, content_sha256, state)
  select team_id, id, 'item', 'team'::access_tier, 'replay-pending', 'retracted' from pending_item
  returning id
), legacy_membership as (
  insert into project_context_memberships (team_id, project_id, context_unit_id, method)
  select legacy_unit.team_id, legacy_item.project_id, legacy_unit.id, 'ingestion_project'
    from legacy_unit join legacy_item on legacy_item.team_id = legacy_unit.team_id
  returning id
)
insert into project_context_memberships (team_id, project_id, context_unit_id, method)
select unit.team_id, item.project_id, unit.id, 'gdrive_claim'
  from unit join item on item.team_id = unit.team_id;
