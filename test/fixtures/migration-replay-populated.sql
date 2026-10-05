-- Populated-replay fixture for `scripts/migrate-from-existing.mjs` (AIO-1167).
--
-- Two rows that use a value only the WIDENED enumerated CHECKs admit, plus the minimum they hang
-- off: an `integrations.type = 'gdrive'` row and a `project_context_memberships.method =
-- 'gdrive_claim'` row. The migration lane inserts them into a scratch database, then replays the
-- whole deploy over them — which is what every later release does to a database that has started
-- using those values — and finally runs each shipped migration RAW to prove these rows would have
-- refused it.
--
-- One statement, so it is atomic and needs no parameters. Run ONLY against a scratch database:
-- it bypasses the application's single writers by design (it is a fixture, and the rows describe a
-- constraint, not a document anyone can read).
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
  insert into items (team_id, project_id, path, kind, access, content_sha256)
  select team_id, id, 'replay/proof.md', 'deliverable'::item_kind, 'team'::access_tier, 'replay-proof' from project
  returning id, team_id, project_id
), unit as (
  insert into project_context_units (team_id, source_item_id, unit_key, audience, content_sha256)
  select team_id, id, 'item', 'team'::access_tier, 'replay-proof' from item
  returning id, team_id
)
insert into project_context_memberships (team_id, project_id, context_unit_id, method)
select unit.team_id, item.project_id, unit.id, 'gdrive_claim'
  from unit join item on item.team_id = unit.team_id;
