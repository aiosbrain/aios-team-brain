-- AIO-1167: replay-safe owner of the legacy Google Drive context suppression.
-- [replay-step gdrive_legacy_context_suppression]
--
-- 20260922130000 introduced connection claims and, in the same file, discarded the generic context
-- units that Drive items had been given before claims existed (their memberships cascade), so that
-- legacy Drive visibility fails closed until an authorized connector re-ingest re-derives it.
--
-- It selected those units as "a Drive item's unit whose item has no active claim". That is only a
-- description of LEGACY context on a database whose claims are present. This file replays on every
-- deploy and on every staging restore, and the paired staging export deliberately does not copy
-- the Drive connection tables (integrations, connection authority, claims, claim projects, run
-- requests, cleanup obligations: credentials, operational queues, and their foreign-key
-- dependents). There every Drive item "has no active claim", so the replay deleted the unit and the
-- claim-authorized memberships of every copied Drive document, and nothing could re-create them.
--
-- The replay plan (scripts/migration-replay-plan.mjs) therefore omits that selection from
-- 20260922130000, and this file owns the suppression with a predicate that does not read the claim
-- tables at all. A unit is legacy generic context exactly when it is
--   · an ACTIVE unit of a Drive item, and
--   · no membership of it was ever written by the claim-authorized entry (`gdrive_claim`).
-- Every legacy unit satisfies that — the method did not exist before the migration above — so the
-- first deploy over legacy Drive content suppresses exactly what it did before, adopted or not.
-- A unit placed by a claim does not, so copied Drive authorization survives a replay unchanged. A
-- RETRACTED unit confers no visibility and is left as the record that its item is suppressed: a
-- pending-cleanup document stays retracted instead of being deleted and looking never-placed.
--
-- Idempotent: once applied there is nothing left to select.
drop table if exists pg_temp.gdrive_legacy_units;
create temp table gdrive_legacy_units(unit_id uuid primary key, team_id uuid not null);
insert into gdrive_legacy_units(unit_id,team_id)
select u.id,u.team_id
  from project_context_units u join items i on i.team_id=u.team_id and i.id=u.source_item_id
 where i.frontmatter->>'source'='gdrive'
   and u.state='active'
   and not exists (
     select 1 from project_context_memberships m
      where m.team_id=u.team_id and m.context_unit_id=u.id and m.method='gdrive_claim'
   )
on conflict do nothing;

-- Fail closed: discard the legacy generic units (their memberships cascade). The next authorized
-- connector re-ingest recreates the unit and its claim memberships through the application owners.
delete from project_context_units u
where u.id in (select unit_id from gdrive_legacy_units);

-- Every team whose Drive visibility was just suppressed owns the epoch/cache barrier.
update team_authorization_epochs e set epoch=e.epoch+1,updated_at=now()
where e.team_id in (select team_id from gdrive_legacy_units);
delete from arc_cache where team_id in (select team_id from gdrive_legacy_units);
delete from work_timeline_cache where team_id in (select team_id from gdrive_legacy_units);
drop table gdrive_legacy_units;
