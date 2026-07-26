-- Human corrections to narrative arcs become DATA (Pass-1 review H13).
--
-- They were written only as `correction:<arc_id>` episodes in Graphiti, inside a swallowed catch, with
-- no Postgres row and no `graph_episodes` ledger entry for reconcile to heal. So the one human-authored
-- input in the whole learning layer lived exclusively in a downstream, rebuildable projection:
--   • a Graphiti rollback (which has happened here) destroyed every correction permanently;
--   • a failed episode write silently reverted the user's edit within one cache TTL — they watched their
--     change land and then disappear, with nothing logged anywhere.
-- Both are the same mistake: using a projection as the record.
--
-- Team-tier by construction — the recompute route already refuses an external principal, and a
-- correction is an internal editorial act. No `access` column, because nothing would filter on it and a
-- tier column no read path honours is worse than none (it reads as protection that isn't there).
create table if not exists arc_corrections (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams(id) on delete cascade,
  -- The arc this corrects. Today `arc_id` is sha(title), which CHURNS on every recompute (M7), so it is
  -- an identifier for dedup — not a durable join key. `arc_title` is stored beside it so a correction
  -- stays diagnosable (and matchable by hand) once the id has moved on.
  arc_id text not null,
  arc_title text not null default '',
  corrected_text text not null check (corrected_text <> ''),
  created_by uuid references members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Latest correction per arc wins: two takes on the same arc would otherwise argue with each other in
  -- the synthesis prompt.
  unique (team_id, arc_id)
);
create index if not exists arc_corrections_team_idx on arc_corrections (team_id, updated_at desc);
