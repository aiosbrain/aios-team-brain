-- Re-key Slack item paths from the channel NAME to the immutable channel ID.
--
-- WHY: `path` is an item's identity (`unique (team_id, project_id, path)`). Keying it on the display
-- name meant a channel RENAME re-keyed every thread → a duplicate item per thread, and nothing
-- diff-deletes those, so both copies persisted in retrieval, credit and the timeline forever. A
-- non-Latin name was worse: `safeSegment` strips everything outside [a-z0-9_-], so CJK/emoji channels
-- collapsed into one shared folder where a Slack `ts` (unique only WITHIN a channel) could collide and
-- overwrite another channel's thread.
--
-- This migration moves existing rows onto the new scheme IN PLACE, preserving each item's id — so
-- `item_versions` (the work ledger that drives credit), `item_chunks` and `graph_episodes` all keep
-- pointing at the same item. A delete-and-reingest would have thrown that history away.
--
-- MERGE-STYLE + IDEMPOTENT: the new code may already have pushed an ID-keyed copy before this runs
-- (a deploy tick between release and schema load). Where BOTH exist, the older name-keyed row is the
-- one with history, so the fresh duplicate is removed first — otherwise the UPDATE would violate the
-- uniqueness constraint. Safe to re-run: after the first pass nothing matches.

begin;

-- The ID-keyed path an item SHOULD have. Mirrors `safeSegment(channelId)` in slack-normalize:
-- Slack ids are uppercase alphanumeric, so lower() is the whole transformation.
create temporary view slack_repath as
select
  i.id,
  i.team_id,
  i.project_id,
  i.path as old_path,
  'slack/' || lower(i.frontmatter ->> 'channel_id') || '/' || split_part(i.path, '/', 3) as new_path
from items i
where i.frontmatter ->> 'source' = 'slack'
  and coalesce(i.frontmatter ->> 'channel_id', '') <> ''
  and split_part(i.path, '/', 1) = 'slack'
  and split_part(i.path, '/', 2) <> lower(i.frontmatter ->> 'channel_id'); -- already migrated → skip

-- 1. Drop any ID-keyed DUPLICATE the new code created in the window. The name-keyed row is older and
--    carries the version history, so it wins; this fresh copy is what would block the UPDATE.
--    `graph_episodes` has NO FK to items (it is an idempotency ledger keyed by source_id), so its rows
--    must be removed explicitly or the duplicate's facts are orphaned in Graphiti forever.
delete from graph_episodes ge
using items dup, slack_repath r
where ge.source_table = 'items'
  and ge.source_id = dup.id
  and dup.team_id = r.team_id
  and dup.project_id = r.project_id
  and dup.path = r.new_path
  and dup.id <> r.id;

delete from items dup
using slack_repath r
where dup.team_id = r.team_id
  and dup.project_id = r.project_id
  and dup.path = r.new_path
  and dup.id <> r.id; -- item_versions / item_chunks cascade on delete

-- 2. Move the surviving (history-carrying) rows onto the ID-keyed path.
update items i
set path = r.new_path
from slack_repath r
where i.id = r.id;

commit;
