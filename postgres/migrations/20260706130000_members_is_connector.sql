-- Distinguish the auto-provisioned per-source ingest actor (lib/ingest/run.ts's
-- resolveConnectorAuth: "slack-sync", "plane-sync", "linear-sync", "github-sync") from a real
-- human team member. These rows exist purely so ingestion has a member_id to attribute its own
-- writes/audit rows to — they were rendering in Admin -> Members and /api/v1/members
-- indistinguishable from a person.
alter table members add column if not exists is_connector boolean not null default false;

-- Backfill the connector rows already auto-provisioned before this column existed.
update members
   set is_connector = true
 where actor_handle in ('slack-sync', 'plane-sync', 'linear-sync', 'github-sync')
   and is_connector = false;
