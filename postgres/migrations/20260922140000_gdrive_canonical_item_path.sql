-- AIO-1167 Batch 2: retain the canonical collision-safe location beside the durable
-- provider-id tombstone. The item row may be removed during final-claim cleanup; reconnect must
-- still reuse its established path instead of falling back to a newly-normalized alias.
alter table source_item_mappings add column if not exists canonical_path text;

update source_item_mappings m
   set canonical_path = i.path,
       project_id = coalesce(m.project_id, i.project_id),
       updated_at = now()
  from items i
 where i.team_id = m.team_id
   and i.id = m.item_id
   and m.source = 'gdrive'
   and (m.canonical_path is distinct from i.path or m.project_id is null);
