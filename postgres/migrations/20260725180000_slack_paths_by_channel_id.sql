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
-- COLLISION-SAFE + IDEMPOTENT: if an ID-keyed target already exists, this migration FAILS CLOSED.
-- Both rows may have independent versions, chunks, graph facts, or Slack evidence, so neither is a
-- disposable duplicate. An operator must resolve the collision with verified provenance before a
-- replay can proceed. With no collision, re-running is a no-op after the first in-place move.

begin;

-- The ID-keyed path an item SHOULD have. Mirrors `safeSegment(channelId)` in slack-normalize:
-- Slack ids are uppercase alphanumeric, so lower() is the whole transformation.
--
-- This is deliberately the ORIGINAL `slack/<channel-name>/<root-ts>.md` shape, not merely a path
-- whose first segment is `slack`. Later migrations add a workspace segment
-- (`slack/<workspace>/<channel-id>/<root-ts>`); a full replay of this historical migration must
-- never reinterpret, rename, or delete that scoped state, even when its frontmatter has an
-- differently-cased channel_id. The old writer emitted a lower-case slug and a valid Slack root
-- timestamp filename; malformed three-segment values are not safe to repair by inference.
create or replace temporary view slack_repath as
select
  i.id,
  i.team_id,
  i.project_id,
  i.path as old_path,
  'slack/' || lower(i.frontmatter ->> 'channel_id') || '/' || split_part(i.path, '/', 3) as new_path
from items i
where i.frontmatter ->> 'source' = 'slack'
  and coalesce(i.frontmatter ->> 'channel_id', '') <> ''
  and i.path ~ '^slack/[a-z0-9_-]+/[1-9][0-9]*[.][0-9]{1,6}[.]md$'
  and split_part(i.path, '/', 2) <> lower(i.frontmatter ->> 'channel_id'); -- already migrated → skip

-- Do this check before any write. The message deliberately contains no path, team, item id or
-- content: deployment logs are operationally visible, while the operator only needs the stable
-- instruction to inspect the migration collision through authorized tooling.
do $$
begin
  if exists (
    select 1
    from slack_repath r
    join items target
      on target.team_id = r.team_id
     and target.project_id = r.project_id
     and target.path = r.new_path
     and target.id <> r.id
  ) then
    raise exception 'slack path migration collision: operator resolution required before replay'
      using errcode = 'P0001';
  end if;
end $$;

-- Move the genuine legacy row IN PLACE only after the no-collision proof.
update items i
set path = r.new_path
from slack_repath r
where i.id = r.id;

-- TEMP views outlive a transaction on a pooled connection. Remove this one so a later full replay
-- is a genuine no-op rather than depending on which connection receives it.
drop view slack_repath;

commit;
