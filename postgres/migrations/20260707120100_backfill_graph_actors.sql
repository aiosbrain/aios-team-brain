-- One-time backfill: project every existing real (non-connector) member into the company
-- graph as an actor entity, so a from-zero replay (and the first rollout of this feature)
-- starts with real data instead of an empty graph_entities table. Ongoing sync from here is
-- lib/graph/company-actors.ts, the sole writer (guarded by
-- test/guards/single-writer-company-graph.test.ts). Idempotent: re-running updates in place,
-- never duplicates (keyed on the same team_id/entity_id the sync module uses).
insert into graph_entities (team_id, entity_id, entity_type, name, attrs)
select
  team_id,
  'member:' || id,
  'actor',
  display_name,
  jsonb_build_object(
    'member_role', role,
    'tier', tier,
    'email', email,
    'status', status,
    'joined_at', created_at,
    'reports_to', case when manager_member_id is not null then 'member:' || manager_member_id else null end
  )
from members
where is_connector = false
on conflict (team_id, entity_id) do update set name = excluded.name, attrs = excluded.attrs;

insert into graph_relationships (team_id, from_id, to_id, relationship_type, attrs)
select team_id, 'member:' || id, 'member:' || manager_member_id, 'REPORTS_TO', '{}'::jsonb
from members
where is_connector = false and manager_member_id is not null
on conflict (team_id, from_id, to_id, relationship_type) do nothing;
