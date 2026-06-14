-- Add 'skill' to the item_kind enum so workspaces can share skills with the team.
-- A skill is its SKILL.md (kind 'skill') carrying a manifest of reference paths in
-- frontmatter; the reference files are pushed as 'artifact' items under the skill's
-- path. See docs/brain-api.md (skill kind + on-demand pull).
alter type item_kind add value if not exists 'skill';
